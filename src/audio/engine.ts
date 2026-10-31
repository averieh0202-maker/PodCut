import { speechTempoMap, tempoDuration } from './speechTempo';
import { SoundTouchNode } from '@soundtouchjs/audio-worklet';
import processorUrl from './speechProcessor?worker&url';
import { tempoLatency, SPEECH_PREROLL_SEC } from './tempoQuality';
import { SPLICE_FADE_SEC } from './splice';
import type { ClipSchedule, TimeRange } from '../edit/types';
import { editedDuration, toOriginal } from '../edit/timeline';
import { GAIN_LINEAR_MAX, linearToElementVolume } from './gain';
import {
  bakeFadedBufferSlice,
  projectToSpeechTime,
  type MixSchedule,
} from './mixSchedule';

/**
 * Web Audio playback that concatenates kept ranges across one or more clips.
 *
 * Speaker path (ONE output only — dual connect = echo / 重声):
 *   BufferSource → GainNode → MediaStreamDestination → HTMLAudioElement
 * AnalyserNode is tapped in parallel (silent meter, not a second speaker).
 *
 * Never connect GainNode to both ctx.destination AND MediaStreamDestination:
 * that plays the same signal twice. Prefer the HTMLAudio route (Safari-safe).
 *
 * Two mutually exclusive play modes:
 *   - simple HTML (<audio src=file>) when ≤0 dB and unedited single clip
 *   - Web Audio graph when boosting, editing, or multi-clip
 * Switching modes always fully stops the other path first.
 *
 * Gesture rules:
 * - Decode via OfflineAudioContext (never create live ctx during fetch).
 * - play() is synchronous: resume + audio.play() + source.start on the
 *   same turn as the click / Space handler (no await before schedule).
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private speed = 1;
  private outputTempo: ReturnType<typeof speechTempoMap> | null = null;
  private outputDuration = 0;
  private refreshOutputTempo(): void {
    this.outputTempo=this.mixSchedule?speechTempoMap(this.mixSchedule,this.speed):null;
    this.outputDuration=this.mixSchedule?tempoDuration(this.mixSchedule,this.speed):0;
  }
  private speechInput: GainNode | null = null;
  private tempoMap: ReturnType<typeof speechTempoMap> | null = null;
  private playStartWall = 0;
  private playbackEndCtx = 0;
  private stretch: SoundTouchNode | null = null;
  private stretchSilence: ConstantSourceNode | null = null;
  private stretchReady: Promise<void> | null = null;
  private speedRequest = 0;
  getPlaybackRate(): number { return this.speed; }
  getRenderSampleRate(): number { return this.ensureCtx().sampleRate; }
  private scheduleSourceStart(ctx:AudioContext):number {
    if(this.speed===1 || !this.stretch)return ctx.currentTime+SPEECH_PREROLL_SEC;
    // Start the worklet only after all source slices are prepared. Otherwise
    // variable main-thread preparation feeds arbitrary silence into WSOLA.
    const block=Math.ceil(ctx.currentTime*ctx.sampleRate/128)+8;
    this.stretch.parameters.get('startBlock')!.value=block;
    return block*128/ctx.sampleRate+SPEECH_PREROLL_SEC;
  }
  async setPlaybackRate(rate: number): Promise<void> {
    if (!Number.isFinite(rate) || rate < .5 || rate > 2) throw Error('播放速度应在 0.5–2 倍之间');
    const request = ++this.speedRequest;
    const ctx = this.ensureCtx();
    // Resume while still inside the user gesture, before registering the module.
    if (ctx.state === 'suspended') void ctx.resume();
    if (rate !== 1) {
      this.stretchReady ??= SoundTouchNode.register(ctx, processorUrl).catch(e => { this.stretchReady = null; throw e; });
      await this.stretchReady;
    }
    if (request !== this.speedRequest) return;
    const at = this.getEditTime(), resume = this.playing;
    this.pause();
    this.speed = rate;
    this.refreshOutputTempo();
    this.playStartEdit = at;
    if (resume) this.play(at);
  }
  private gainNode: GainNode | null = null;
  private speakerDest: MediaStreamAudioDestinationNode | null = null;
  private analyser: AnalyserNode | null = null;
  private speakerEl: HTMLAudioElement | null = null;
  /** Direct file/blob URL for emergency HTMLAudio preview (demo / single clip). */
  private fallbackUrl: string | null = null;
  private fallbackEl: HTMLAudioElement | null = null;
  private gainValue = 1;
  private clips: ClipSchedule[] = [];
  /** Buffers adapted onto the live AudioContext (Safari prefers these). */
  private adapted = new WeakMap<AudioBuffer, AudioBuffer>();
  private sources: AudioBufferSourceNode[] = [];
  /** Per-source fade gains (music); must be disconnected with sources. */
  private sourceGains: GainNode[] = [];
  /** When set (esp. with music), playback uses absolute mix sources. */
  private mixSchedule: MixSchedule | null = null;
  private usesMixSchedule = false;
  private playing = false;
  private playStartCtx = 0;
  private playStartEdit = 0;
  private scheduledEndEdit = 0;
  private raf = 0;
  private healthTimer = 0;
  private onTick:
    | ((editTime: number, clipIndex: number | null, originalTime: number | null) => void)
    | null = null;
  private onEnded: (() => void) | null = null;
  private onWarn: ((msg: string) => void) | null = null;

  setWarnHandler(fn: ((msg: string) => void) | null): void {
    this.onWarn = fn;
  }

  /** Optional WAV/MP3 URL used if Web Audio meters as silent (Safari speakers). */
  setFallbackUrl(url: string | null): void {
    if (this.fallbackUrl && this.fallbackUrl.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(this.fallbackUrl);
      } catch {
        /* */
      }
    }
    this.fallbackUrl = url;
  }

  private unlockAudioSession(): void {
    try {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'playback';
    } catch {
      /* older browsers */
    }
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AC =
        window.AudioContext ||
        (
          window as unknown as {
            webkitAudioContext: typeof AudioContext;
          }
        ).webkitAudioContext;
      this.ctx = new AC();
      this.gainNode = null;
      this.stretchReady = null;
      this.stretch = null;
      this.speakerDest = null;
      this.analyser = null;
      this.adapted = new WeakMap();
    }
    if (!this.gainNode || this.gainNode.context !== this.ctx) {
      this.gainNode = this.ctx.createGain();
      this.applyGainToNode(this.gainNode);
    }
    return this.ctx;
  }

  /**
   * Wire gain → MediaStreamDestination → <audio> (ONLY audible output),
   * and gain → analyser (meter only). Never also tap ctx.destination.
   * Call HTMLAudioElement.play() from the gesture turn.
   */
  private ensureSpeakerGraph(ctx: AudioContext, gain: GainNode): HTMLAudioElement {
    if (!this.speakerDest || this.speakerDest.context !== ctx) {
      this.speakerDest = ctx.createMediaStreamDestination();
    }
    if (!this.analyser || this.analyser.context !== ctx) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
    }

    // Fresh connects every play — Safari sometimes drops the graph.
    // ONE speaker path only: MediaStream → HTMLAudio (not ctx.destination).
    try {
      gain.disconnect();
    } catch {
      /* first time */
    }
    // A new processor per play/seek clears queued sound from the previous position.
    this.stretchSilence?.stop();
    this.stretchSilence?.disconnect();
    this.stretchSilence = null;
    this.stretch?.disconnect();
    this.stretch?.port.close();
    this.stretch = null;
    this.speechInput?.disconnect();
    this.speechInput = null;
    let output: AudioNode = gain;
    if (this.speed !== 1) {
      this.stretch = new SoundTouchNode({ context: ctx });
      this.stretch.parameters.get('startBlock')!.value=1e9;
      this.stretch.playbackRate.value = this.speed;
      this.stretch.pitch.value = 1;
      // The processor owns one shared, tested quality preset and output reserve.
      this.stretchSilence = ctx.createConstantSource();
      this.stretchSilence.offset.value = 0;
      this.speechInput = this.usesMixSchedule ? ctx.createGain() : gain;
      this.stretchSilence.connect(this.speechInput);
      this.stretchSilence.start();
      this.speechInput.connect(this.stretch);
      if(this.usesMixSchedule) this.stretch.connect(gain);
      else output = this.stretch;
    }
    output.connect(this.speakerDest);
    output.connect(this.analyser);
    this.applyGainToNode(gain);

    if (!this.speakerEl) {
      const el = document.createElement('audio');
      el.setAttribute('playsinline', 'true');
      el.setAttribute('webkit-playsinline', 'true');
      el.preload = 'auto';
      el.controls = false;
      el.style.position = 'fixed';
      el.style.width = '1px';
      el.style.height = '1px';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      el.style.left = '-9999px';
      document.body.appendChild(el);
      this.speakerEl = el;
    }
    const el = this.speakerEl;
    el.muted = false;
    el.volume = 1;
    if (el.srcObject !== this.speakerDest.stream) {
      el.srcObject = this.speakerDest.stream;
    }
    return el;
  }

  /** Fully stop direct-file HTMLAudio fallback (pause + clear src). */
  private stopHtmlFallbackFully(): void {
    const a = this.fallbackEl;
    if (!a) return;
    try {
      a.onended = null;
      a.pause();
    } catch {
      /* */
    }
    try {
      a.removeAttribute('src');
      a.src = '';
      a.load();
    } catch {
      /* */
    }
    this.fallbackEl = null;
  }

  /** Pause MediaStream speaker element (keep srcObject for next Web Audio play). */
  private pauseSpeakerEl(): void {
    try {
      this.speakerEl?.pause();
    } catch {
      /* */
    }
  }

  /** Disconnect gain from any destinations so residual graph cannot sound. */
  private disconnectGainGraph(): void {
    this.stretchSilence?.stop();
    this.stretchSilence?.disconnect();
    this.stretchSilence = null;
    this.stretch?.disconnect();
    this.stretch?.port.close();
    this.stretch = null;
    if (!this.gainNode) return;
    try {
      this.gainNode.disconnect();
    } catch {
      /* */
    }
  }

  private applyGainToNode(node: GainNode): void {
    const g = this.usesMixSchedule ? 1 : this.gainValue;
    try {
      const t = node.context.currentTime;
      node.gain.cancelScheduledValues(t);
      node.gain.setValueAtTime(g, t);
    } catch {
      node.gain.value = g;
    }
  }

  /** Copy buffer into one owned by the live context (Safari reliability). */
  private adaptBuffer(ctx: AudioContext, src: AudioBuffer): AudioBuffer {
    const cached = this.adapted.get(src);
    if (cached && cached.sampleRate === src.sampleRate && cached.length === src.length) {
      return cached;
    }
    const out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
    for (let c = 0; c < src.numberOfChannels; c++) {
      const data = src.getChannelData(c);
      out.copyToChannel(new Float32Array(data), c);
    }
    this.adapted.set(src, out);
    return out;
  }

  /**
   * Decode without touching the live playback AudioContext (Safari-safe).
   * Large podcasts (100MB+): avoid data.slice(0) double-copy which OOMs restore
   * after IDB/OPFS read (~259MB ×2 + PCM). Safari may detach the buffer — on
   * failure retry once with a copy.
   */
  async decodeArrayBuffer(data: ArrayBuffer): Promise<AudioBuffer> {
    const Offline =
      window.OfflineAudioContext ||
      (
        window as unknown as {
          webkitOfflineAudioContext: typeof OfflineAudioContext;
        }
      ).webkitOfflineAudioContext;
    const tmp = new Offline(1, 1, 44100);
    const large = data.byteLength >= 8 * 1024 * 1024;
    if (large) {
      try {
        return await tmp.decodeAudioData(data);
      } catch (first) {
        // Safari often needs a copy; only copy on failure to limit peak RAM.
        try {
          return await tmp.decodeAudioData(data.slice(0));
        } catch {
          throw first;
        }
      }
    }
    return tmp.decodeAudioData(data.slice(0));
  }

  setClips(clips: ClipSchedule[]): void {
    // Do not auto-restart here: callers update mixSchedule then decide whether to play.
    // Auto-play used the stale mix and made fade/gain tweaks seem to "do nothing".
    this.clips = clips.map((c) => ({
      buffer: c.buffer,
      ranges: c.ranges.map((r) => ({ ...r })),
    }));
    this.adapted = new WeakMap();
    // B1: if the edit list is no longer a full uncut clip, abandon HTML full-file playback
    // so deleted ranges cannot keep sounding via the fallback element.
    if (this.simpleClock && !this.isSimpleFullClip()) {
      const t = this.getEditTime();
      this.stopHtmlFallbackFully();
      this.simpleClock = false;
      this.playing = false;
      this.playStartEdit = t;
      cancelAnimationFrame(this.raf);
      window.clearTimeout(this.healthTimer);
    }
  }

  /**
   * Full mix schedule (speech + beds + stingers).
   * When music is present, play() always uses Web Audio from these sources.
   */
  setMixSchedule(mix: MixSchedule | null): void {
    this.mixSchedule = mix;
    this.refreshOutputTempo();
    this.usesMixSchedule = !!mix && (mix.hasClipGain || mix.sources.some((x) => x.role !== 'speech'));
    // Keep clips in sync for locate when mix is speech-only / music
  }

  /** Linear amplitude (from dbToLinear). GainNode carries full value incl. boosts > 1. */
  setGain(gain: number): void {
    const n = Number(gain);
    // Allow up to ~+36 dB (~63×). Floor at 0.
    this.gainValue = Number.isFinite(n)
      ? Math.max(0, Math.min(GAIN_LINEAR_MAX, n))
      : 1;
    // With music mix, per-source gains already include master — keep bus at unity.
    if (this.usesMixSchedule) {
      if (this.gainNode) {
        try {
          const t = this.gainNode.context.currentTime;
          this.gainNode.gain.cancelScheduledValues(t);
          this.gainNode.gain.setValueAtTime(1, t);
        } catch {
          this.gainNode.gain.value = 1;
        }
      }
      if (this.speakerEl) this.speakerEl.volume = 1;
      return;
    }
    if (this.gainNode) this.applyGainToNode(this.gainNode);
    // MediaStream path: GainNode already applied gain — keep element at unity.
    if (this.speakerEl) this.speakerEl.volume = 1;
    // Direct HTMLAudio fallback: element.volume is 0–1 only (no boost).
    if (this.fallbackEl) this.fallbackEl.volume = linearToElementVolume(this.gainValue);
    // Crossing into boost while on HTML-simple: stop HTML first, then Web Audio.
    if (this.playing && this.simpleClock && this.gainValue > 1 + 1e-6) {
      const t = this.getEditTime();
      this.stopHtmlFallbackFully();
      this.simpleClock = false;
      this.play(t);
      return;
    }
    // Crossing back to ≤0 dB while on Web Audio simple-clip: prefer HTML path.
    if (
      this.playing &&
      !this.simpleClock &&
      this.gainValue <= 1 + 1e-6 &&
      this.isSimpleFullClip()
    ) {
      const t = this.getEditTime();
      this.stopSourcesOnly();
      this.disconnectGainGraph();
      this.pauseSpeakerEl();
      this.play(t);
    }
  }

  getGain(): number {
    return this.gainValue;
  }

  getEditDuration(): number {
    if (this.mixSchedule && (this.usesMixSchedule || this.mixSchedule.sources.length > 0)) {
      return this.mixSchedule.totalDuration;
    }
    return this.clips.reduce((sum, c) => sum + editedDuration(c.ranges), 0);
  }

  getOutputTime(): number {
    return this.outputTempo ? this.outputTempo.toWall(this.getEditTime()) : this.getEditTime()/this.speed;
  }

  getOutputDuration(): number {
    return this.mixSchedule ? this.outputDuration : this.getEditDuration()/this.speed;
  }

  getOriginalDuration(): number {
    return this.clips.reduce((sum, c) => sum + (c.buffer?.duration ?? 0), 0);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getContextState(): string {
    return this.ctx?.state ?? 'none';
  }

  setHandlers(opts: {
    onTick?: (
      editTime: number,
      clipIndex: number | null,
      originalTime: number | null,
    ) => void;
    onEnded?: () => void;
  }): void {
    this.onTick = opts.onTick ?? null;
    this.onEnded = opts.onEnded ?? null;
  }

  getEditTime(): number {
    if (!this.playing) return this.playStartEdit;
    if (this.simpleClock && this.fallbackEl) {
      return Math.min(this.fallbackEl.currentTime, this.scheduledEndEdit);
    }
    if (!this.ctx) return this.playStartEdit;
    const elapsed = Math.max(0,this.ctx.currentTime-this.playStartCtx);
    const t = this.tempoMap ? this.tempoMap.toProject(this.playStartWall+elapsed) : this.playStartEdit+elapsed*this.speed;
    return Math.max(this.playStartEdit, Math.min(t, this.scheduledEndEdit));
  }

  /** Unlock live context; safe on click/Space. Prefer fire-and-forget. */
  resumeCtx(): Promise<void> {
    this.unlockAudioSession();
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') return ctx.resume().then(() => undefined);
    return Promise.resolve();
  }

  locateEdit(editTime: number): {
    clipIndex: number;
    localEdit: number;
    ranges: TimeRange[];
  } | null {
    if (this.clips.length === 0) return null;
    let t = 0;
    for (let i = 0; i < this.clips.length; i++) {
      const d = editedDuration(this.clips[i]!.ranges);
      if (editTime <= t + d + 1e-6 || i === this.clips.length - 1) {
        return {
          clipIndex: i,
          localEdit: Math.max(0, editTime - t),
          ranges: this.clips[i]!.ranges,
        };
      }
      t += d;
    }
    return null;
  }

  clipEditOffset(index: number): number {
    let t = 0;
    for (let i = 0; i < index && i < this.clips.length; i++) {
      t += editedDuration(this.clips[i]!.ranges);
    }
    return t;
  }

  /**
   * Start playback synchronously (no await). Must run on a user-gesture turn.
   */
  /** True when one clip, one full-buffer range — safe for direct <audio> play. */
  private isSimpleFullClip(): boolean {
    if (this.usesMixSchedule) return false;
    if (this.clips.length !== 1 || !this.fallbackUrl) return false;
    const c = this.clips[0]!;
    if (!c.buffer || c.ranges.length !== 1) return false;
    const r = c.ranges[0]!;
    return r.start <= 1e-4 && Math.abs(r.end - c.buffer.duration) < 0.05;
  }

  /** Primary audible path for demo / unedited single file (Safari-reliable). */
  private playSimpleHtmlAudio(fromEditTime: number): boolean {
    if (!this.fallbackUrl) return false;
    try {
      // Kill Web Audio path completely so we never stack two outputs.
      this.stopSourcesOnly();
      this.disconnectGainGraph();
      this.pauseSpeakerEl();
      this.stopHtmlFallbackFully();
      const a = new Audio(this.fallbackUrl);
      a.setAttribute('playsinline', 'true');
      a.volume = linearToElementVolume(this.gainValue);
      a.preservesPitch = true;
      a.playbackRate = this.speed;
      const total = this.getEditDuration();
      const startAt = Math.max(0, Math.min(fromEditTime, Math.max(0, total - 0.001)));
      const start = () => {
        try {
          a.currentTime = startAt;
        } catch {
          /* */
        }
      };
      if (a.readyState >= 1) start();
      else a.addEventListener('loadedmetadata', start, { once: true });
      const playAttempt = a.play();
      if (playAttempt && typeof playAttempt.catch === 'function') {
        playAttempt.catch(() => {
          this.onWarn?.('直通播放被拦截：请再点一次「播放」');
        });
      }
      this.fallbackEl = a;
      this.playing = true;
      this.playStartEdit = startAt;
      this.scheduledEndEdit = total;
      // Drive playhead from element clock (no AudioContext required).
      const tick = () => {
        if (!this.playing || !this.fallbackEl) return;
        const t = this.fallbackEl.currentTime;
        this.playStartEdit = t;
        this.playStartCtx = this.ctx?.currentTime ?? 0;
        // Fake: getEditTime uses ctx when playing — override by setting playing
        // with a synthetic clock via playStartEdit updates in RAF.
        this.emitTickSimple(t);
        if (t >= total - 0.05 || this.fallbackEl.paused) {
          if (t >= total - 0.05) {
            this.playing = false;
            this.playStartEdit = total;
            this.onEnded?.();
            this.emitTickSimple(total);
            return;
          }
        }
        this.raf = requestAnimationFrame(tick);
      };
      // Patch getEditTime path: store simpleMode clock
      this.simpleClock = true;
      this.raf = requestAnimationFrame(tick);
      a.onended = () => {
        this.playing = false;
        this.playStartEdit = total;
        this.simpleClock = false;
        cancelAnimationFrame(this.raf);
        this.onEnded?.();
        this.emitTickSimple(total);
      };
      return true;
    } catch {
      return false;
    }
  }

  private simpleClock = false;

  private emitTickSimple(editTime: number): void {
    const loc = this.locateEdit(editTime);
    if (!loc) {
      this.onTick?.(editTime, null, null);
      return;
    }
    const original = toOriginal(loc.ranges, loc.localEdit);
    this.onTick?.(editTime, loc.clipIndex, original);
  }

  play(fromEditTime = 0): void {
    if (this.clips.length === 0 && !(this.mixSchedule && this.mixSchedule.sources.length > 0)) {
      return;
    }

    this.unlockAudioSession();
    this.simpleClock = false;
    this.tempoMap = null;

    // With music/SFX, always use the mix Web Audio path.
    if (this.usesMixSchedule && this.mixSchedule) {
      this.playFromMix(fromEditTime);
      return;
    }

    // Demo / unedited single file: HTMLAudio is Safari-reliable for attenuation,
    // but element.volume is clamped to 1 — any boost (>0 dB) MUST use GainNode.
    if (
      this.gainValue <= 1 + 1e-6 &&
      this.isSimpleFullClip() &&
      this.playSimpleHtmlAudio(fromEditTime)
    ) {
      window.clearTimeout(this.healthTimer);
      return;
    }

    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') void ctx.resume();

    // Stop every other audible path before scheduling Web Audio.
    this.stopSourcesOnly();
    this.stopHtmlFallbackFully();
    this.simpleClock = false;

    const gain = this.gainNode!;
    const speaker = this.ensureSpeakerGraph(ctx, gain);

    // Must be on the gesture turn — do not await.
    const playAttempt = speaker.play();
    if (playAttempt && typeof playAttempt.catch === 'function') {
      playAttempt.catch(() => {
        this.onWarn?.(
          '浏览器拦截了音频播放：请再点一次「播放」，并检查标签页/系统是否静音',
        );
      });
    }

    const total = this.getEditDuration();
    if (total <= 1e-4) {
      this.playing = false;
      this.onWarn?.('当前剪辑时长为 0，没有可播放的片段');
      this.onEnded?.();
      return;
    }

    const startAt = Math.max(0, Math.min(fromEditTime, Math.max(0, total - 0.001)));
    let when = 0;
    const prepared: {node:AudioBufferSourceNode; when:number; offset:number; duration:number}[] = [];
    let editPos = 0;
    this.sources = [];

    for (const clip of this.clips) {
      if (!clip.buffer) continue;
      const buffer = this.adaptBuffer(ctx, clip.buffer);
      for (const r of clip.ranges) {
        const dur = r.end - r.start;
        if (dur <= 1e-4) continue;
        if (editPos + dur <= startAt + 1e-6) {
          editPos += dur;
          continue;
        }
        const offsetInRange = startAt > editPos ? startAt - editPos : 0;
        const playDur = dur - offsetInRange;
        if (playDur <= 1e-4) {
          editPos += dur;
          continue;
        }
        const offset = r.start + offsetInRange;
        const maxOffset = Math.max(0, buffer.duration - 1e-4);
        const safeOffset = Math.min(Math.max(0, offset), maxOffset);
        const safeDur = Math.min(playDur, Math.max(0, buffer.duration - safeOffset));
        if (safeDur <= 1e-4) {
          editPos += dur;
          continue;
        }
        const src = ctx.createBufferSource();
        const fadeIn = r.start > 0.0001 ? SPLICE_FADE_SEC : 0;
        const fadeOut = r.end < buffer.duration - 0.0001 ? SPLICE_FADE_SEC : 0;
        src.buffer = fadeIn || fadeOut ? bakeFadedBufferSlice(ctx, buffer, safeOffset, safeDur, fadeIn, fadeOut, dur, offsetInRange) : buffer;
        src.connect(gain);
        prepared.push({node:src,when,offset:fadeIn || fadeOut ? 0 : safeOffset,duration:safeDur});
        this.sources.push(src);
        when += safeDur;
        editPos += dur;
      }
    }

    // PCM adaptation/fades can take seconds on a long podcast. Only start
    // the clock AFTER every buffer/node is ready; repeated play must not skip
    // sources whose former scheduled start expired during synchronous baking.
    const startCtx=this.scheduleSourceStart(ctx);
    for(const p of prepared) { p.node.playbackRate.value=this.speed; p.node.start(startCtx+p.when/this.speed,p.offset,p.duration); }
    this.playing = true;
    this.playStartCtx = startCtx + (this.speed === 1 ? 0 : tempoLatency(ctx.sampleRate));
    this.playStartEdit = startAt;
    this.scheduledEndEdit = total;
    this.playbackEndCtx = this.playStartCtx+(total-startAt)/this.speed;

    if (this.sources.length === 0) {
      this.playing = false;
      this.onWarn?.('没有排到可播放的音频（片段或范围为空）');
      this.onEnded?.();
      return;
    }

    const last = this.sources[this.sources.length - 1]!;
    last.onended = () => {
      if (!this.sources.includes(last)) return;
      if (ctx.currentTime >= this.playbackEndCtx - .005) {
        this.playing = false;
        this.playStartEdit = this.scheduledEndEdit;
        cancelAnimationFrame(this.raf);
        this.pauseSpeakerEl();
        this.onEnded?.();
        this.emitTick();
      }
    };

    const loop = () => {
      if (!this.playing) return;
      this.emitTick();
      if (ctx.currentTime >= this.playbackEndCtx) {
        this.playing = false;
        this.playStartEdit = this.scheduledEndEdit;
        this.pauseSpeakerEl();
        this.onEnded?.();
        this.emitTick();
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);

    window.clearTimeout(this.healthTimer);
    this.healthTimer = window.setTimeout(() => this.healthCheck(), 280);
  }

  /** Async wrapper kept for older call sites. */
  async playAsync(fromEditTime = 0): Promise<void> {
    this.play(fromEditTime);
  }

  private tryFallbackHtmlAudio(): boolean {
    // Never abandon a music mix — HTML path has no beds/stingers/fades.
    if (this.usesMixSchedule) return false;
    // HTML element cannot amplify above 0 dB — do not use for boosts.
    if (this.gainValue > 1 + 1e-6) return false;
    if (!this.fallbackUrl || this.clips.length === 0) return false;
    // B1: NEVER play the raw original file once the edit list is cut.
    // The old "last resort" path re-introduced deleted word audio.
    // Only the unedited single full-clip case may use HTMLAudio.
    if (!this.isSimpleFullClip()) return false;
    try {
      const t = this.getEditTime();
      this.stopSourcesOnly();
      this.disconnectGainGraph();
      this.pauseSpeakerEl();
      this.stopHtmlFallbackFully();
      return this.playSimpleHtmlAudio(t);
    } catch {
      return false;
    }
  }

  /** Nudge only the speaker output. Replacing the stretch/input bus here would
   * disconnect already scheduled speech sources while leaving music audible. */
  private reconnectSpeakerOutput(): void {
    const output = this.speed !== 1 && !this.usesMixSchedule ? this.stretch : this.gainNode;
    if (!output || !this.speakerDest || !this.analyser) return;
    output.disconnect();
    output.connect(this.speakerDest);
    output.connect(this.analyser);
  }

  private healthCheck(): void {
    if (!this.playing) return;
    const ctx = this.ctx;
    if (!ctx) return;

    if (ctx.state === 'suspended') {
      void ctx.resume();
      void this.speakerEl?.play();
      this.onWarn?.(
        '浏览器音频未解锁：请再点一次「播放」，并检查系统/标签页是否静音',
      );
      return;
    }

    if (!this.analyser || this.sources.length === 0) return;

    // Music beds often start with a long baked fade-in (and −15 dB).
    // A quiet first 300ms is expected — NEVER HTML-fallback the mix path
    // (fallback strips beds/stingers and made 渐入/渐出 look broken).
    if (this.usesMixSchedule) {
      this.reconnectSpeakerOutput();
      void this.speakerEl?.play();
      return;
    }

    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));

    // Near-flat waveform while we expect audio → rewire + nudge.
    if (peak < 2) {
      this.reconnectSpeakerOutput();
      void this.speakerEl?.play();
      // Second sample shortly after rewire
      window.setTimeout(() => {
        if (!this.playing || !this.analyser) return;
        if (this.usesMixSchedule) return;
        this.analyser.getByteTimeDomainData(data);
        let peak2 = 0;
        for (const v of data) peak2 = Math.max(peak2, Math.abs(v - 128));
        if (peak2 < 2) {
          const rescued = this.tryFallbackHtmlAudio();
          this.onWarn?.(
            rescued
              ? 'Web Audio 无声，已改用直通播放；若仍无声请检查 Mac 静音键 / 输出设备'
              : '几乎听不到声音：请点「播放」按钮（不要只按空格），并检查 Mac 静音键 / 输出设备',
          );
        }
      }, 200);
    }
  }


  /** Schedule absolute mix sources (speech + beds + stingers). */
  private playFromMix(fromEditTime: number): void {
    const mix = this.mixSchedule;
    if (!mix || mix.sources.length === 0) {
      this.playing = false;
      this.onWarn?.('没有可播放的混音时间轴');
      this.onEnded?.();
      return;
    }

    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') void ctx.resume();

    this.stopSourcesOnly();
    this.stopHtmlFallbackFully();
    this.simpleClock = false;

    const master = this.gainNode!;
    // Master stays at 1 — per-source gains already include master * placement.
    const prevGain = this.gainValue;
    this.gainValue = 1;
    this.applyGainToNode(master);
    this.gainValue = prevGain;

    const speaker = this.ensureSpeakerGraph(ctx, master);
    const playAttempt = speaker.play();
    if (playAttempt && typeof playAttempt.catch === 'function') {
      playAttempt.catch(() => {
        this.onWarn?.(
          '浏览器拦截了音频播放：请再点一次「播放」，并检查标签页/系统是否静音',
        );
      });
    }

    const total = mix.totalDuration;
    if (total <= 1e-4) {
      this.playing = false;
      this.onWarn?.('当前混音时长为 0');
      this.onEnded?.();
      return;
    }

    const startAt = Math.max(0, Math.min(fromEditTime, Math.max(0, total - 0.001)));
    const tempo = speechTempoMap(mix,this.speed);
    this.tempoMap = tempo;
    const wallStart = tempo.toWall(startAt);
    this.playStartWall = wallStart;
    const prepared: {node:AudioBufferSourceNode; when:number; offset:number; duration:number;rate:number}[] = [];
    let wallEnd = wallStart;
    this.sources = [];
    this.sourceGains = [];

    for (const src of mix.sources) {
      const rate = src.role === 'speech' ? this.speed : 1;
      const begins = tempo.toWall(src.whenEdit);
      const ends = begins+src.duration/rate;
      wallEnd = Math.max(wallEnd,ends);
      if (ends <= wallStart + 1e-6) continue;
      const offsetIn = Math.max(0,wallStart-begins)*rate;
      const playDur = src.duration - offsetIn;
      if (playDur <= 1e-4) continue;

      const buffer = this.adaptBuffer(ctx, src.buffer);
      const bufOff = src.offset + offsetIn;
      const maxOff = Math.max(0, buffer.duration - 1e-4);
      const safeOff = Math.min(Math.max(0, bufOff), maxOff);
      const safeDur = Math.min(playDur, Math.max(0, buffer.duration - safeOff));
      if (safeDur <= 1e-4) continue;

      const when = Math.max(0,begins+offsetIn/rate-wallStart);
      const node = ctx.createBufferSource();
      const peak = Math.max(0, src.gainLinear);
      const fadeIn = src.role === 'speech' ? (src.offset > 0.0001 ? SPLICE_FADE_SEC : 0) : (src.fadeInSec ?? 0);
      const fadeOut = src.role === 'speech' ? (src.offset + src.duration < buffer.duration - 0.0001 ? SPLICE_FADE_SEC : 0) : (src.fadeOutSec ?? 0);
      // Bake fades into samples — GainNode automation is unreliable on
      // Safari + MediaStreamDestination (looked like "渐入渐出没变").
      if (fadeIn > 1e-6 || fadeOut > 1e-6) {
        node.buffer = bakeFadedBufferSlice(
          ctx,
          buffer,
          safeOff,
          safeDur,
          fadeIn,
          fadeOut,
          src.duration,
          offsetIn,
        );
        // Whole slice already faded; play from 0 for full baked length.
        const g = ctx.createGain();
        g.gain.value = peak;
        node.connect(g);
        g.connect(src.role==='speech' ? this.speechInput??master : master);
        prepared.push({node,when,offset:0,duration:node.buffer.duration,rate});
        this.sources.push(node);
        this.sourceGains.push(g);
      } else {
        node.buffer = buffer;
        const g = ctx.createGain();
        g.gain.value = peak;
        node.connect(g);
        g.connect(src.role==='speech' ? this.speechInput??master : master);
        prepared.push({node,when,offset:safeOff,duration:safeDur,rate});
        this.sources.push(node);
        this.sourceGains.push(g);
      }
    }

    const t0=this.scheduleSourceStart(ctx);
    for(const p of prepared) { p.node.playbackRate.value=p.rate; p.node.start(t0+p.when+(p.rate===1&&this.speed!==1?tempoLatency(ctx.sampleRate):0),p.offset,p.duration); }
    this.playing = true;
    // Match the short WSOLA latency on the untouched music path so a
    // stinger cannot begin before the preceding spoken tail has emerged.
    this.playStartCtx = t0+(this.speed===1?0:tempoLatency(ctx.sampleRate));
    this.playStartEdit = startAt;
    this.scheduledEndEdit = total;
    this.playbackEndCtx = t0+wallEnd-wallStart+(this.speed===1?0:tempoLatency(ctx.sampleRate));

    if (this.sources.length === 0) {
      this.playing = false;
      this.onWarn?.('没有排到可播放的混音片段');
      this.onEnded?.();
      return;
    }

    const last = this.sources[this.sources.length - 1]!;
    last.onended = () => {
      if (!this.sources.includes(last)) return;
      if (ctx.currentTime >= this.playbackEndCtx - .005) {
        this.playing = false;
        this.playStartEdit = this.scheduledEndEdit;
        cancelAnimationFrame(this.raf);
        this.pauseSpeakerEl();
        this.onEnded?.();
        this.emitTick();
      }
    };

    const loop = () => {
      if (!this.playing) return;
      this.emitTick();
      if (ctx.currentTime >= this.playbackEndCtx) {
        this.playing = false;
        this.playStartEdit = this.scheduledEndEdit;
        this.pauseSpeakerEl();
        this.onEnded?.();
        this.emitTick();
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    window.clearTimeout(this.healthTimer);
    this.healthTimer = window.setTimeout(() => this.healthCheck(), 280);
  }

  pause(): void {
    if (!this.playing) return;
    const t = this.getEditTime();
    this.stopSourcesOnly();
    this.disconnectGainGraph();
    this.pauseSpeakerEl();
    this.stopHtmlFallbackFully();
    this.playing = false;
    this.simpleClock = false;
    this.playStartEdit = t;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.healthTimer);
    this.emitTick();
  }

  stop(): void {
    this.stopSourcesOnly();
    this.disconnectGainGraph();
    this.pauseSpeakerEl();
    this.stopHtmlFallbackFully();
    this.playing = false;
    this.simpleClock = false;
    this.playStartEdit = 0;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.healthTimer);
    this.emitTick();
  }

  seek(editTime: number): void {
    const total = this.getEditDuration();
    const t = Math.max(0, Math.min(editTime, total));
    if (this.playing) {
      this.play(t);
    } else {
      this.playStartEdit = t;
      this.emitTick();
    }
  }

  /** Map pure-speech edit time → project time (accounts for stinger gaps). */
  speechEditToProject(speechEdit: number): number {
    if (!this.usesMixSchedule || !this.mixSchedule) return speechEdit;
    const segs = this.mixSchedule.segs;
    for (const seg of segs) {
      if (seg.kind !== 'speech') continue;
      if (speechEdit + 1e-9 >= seg.speechStart && speechEdit <= seg.speechEnd + 1e-9) {
        return seg.projectStart + (speechEdit - seg.speechStart);
      }
    }
    // After last speech / on stinger anchor
    let best = speechEdit;
    for (const seg of segs) {
      if (seg.kind === 'speech' && seg.speechEnd <= speechEdit + 1e-9) {
        best = seg.projectEnd + (speechEdit - seg.speechEnd);
      }
    }
    return best;
  }

  /** Start at the first retained sample, including leading pauses/stingers. */
  seekClipStart(clipIndex: number): void {
    if (clipIndex < 0 || clipIndex >= this.clips.length) return;
    this.seek(clipIndex === 0 ? 0 : this.speechEditToProject(this.clipEditOffset(clipIndex)));
  }

  seekOriginal(clipIndex: number, originalTime: number): void {
    if (clipIndex < 0 || clipIndex >= this.clips.length) return;
    const ranges = this.clips[clipIndex]!.ranges;
    const base = this.clipEditOffset(clipIndex);
    let edit = 0;
    for (const r of ranges) {
      if (originalTime >= r.start && originalTime <= r.end) {
        this.seek(this.speechEditToProject(base + edit + (originalTime - r.start)));
        return;
      }
      edit += r.end - r.start;
    }
    let bestEdit = 0;
    let bestDist = Infinity;
    edit = 0;
    for (const r of ranges) {
      const d0 = Math.abs(originalTime - r.start);
      const d1 = Math.abs(originalTime - r.end);
      if (d0 < bestDist) {
        bestDist = d0;
        bestEdit = edit;
      }
      if (d1 < bestDist) {
        bestDist = d1;
        bestEdit = edit + (r.end - r.start);
      }
      edit += r.end - r.start;
    }
    this.seek(this.speechEditToProject(base + bestEdit));
  }

  private emitTick(): void {
    const editTime = this.getEditTime();
    // With stingers, playhead is on project timeline — map back to speech for words.
    let speechTime = editTime;
    if (this.usesMixSchedule && this.mixSchedule) {
      const segment = this.mixSchedule.segs.find(s => editTime >= s.projectStart && editTime < s.projectEnd);
      if (segment?.kind === 'stinger') {
        this.onTick?.(editTime, null, null);
        return;
      }
      speechTime = projectToSpeechTime(
        editTime,
        this.mixSchedule.segs,
        this.mixSchedule.speechDuration,
      );
    }
    const loc = this.locateEdit(speechTime);
    if (!loc) {
      this.onTick?.(editTime, null, null);
      return;
    }
    const original = toOriginal(loc.ranges, loc.localEdit);
    this.onTick?.(editTime, loc.clipIndex, original);
  }

  private stopSourcesOnly(): void {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
        s.disconnect();
      } catch {
        /* already stopped */
      }
    }
    for (const g of this.sourceGains) {
      try {
        g.disconnect();
      } catch {
        /* */
      }
    }
    this.sources = [];
    this.sourceGains = [];
    cancelAnimationFrame(this.raf);
  }

  getClips(): ClipSchedule[] {
    return this.clips.map((c) => ({
      buffer: c.buffer,
      ranges: c.ranges.map((r) => ({ ...r })),
    }));
  }
}
