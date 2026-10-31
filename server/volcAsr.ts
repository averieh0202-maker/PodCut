/**
 * 火山引擎豆包语音 — 录音文件识别标准版 2.0（submit + query）
 *
 * Docs:
 * - submit: https://docs.volcengine.com/docs/DoubaoVoice/task-submission-http-1
 * - query:  https://docs.volcengine.com/docs/6561/2606792
 *
 * Standard setup: X-Api-Key + X-Api-Resource-Id: volc.seedasr.auc
 * Local files: try audio.data (base64) first; optional audio.url for public links.
 *
 * Note: enable_punc puts punctuation into result.text / utterance.text;
 * words[] are usually bare characters without punct — we merge punct back in.
 */

import { randomUUID } from 'node:crypto';

export const SUBMIT_URL =
  'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit';
export const QUERY_URL =
  'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query';

export interface VolcCreds {
  /** Used as X-Api-Key (new console). */
  apiKey: string;
  /** Optional old-console Access Token. */
  accessKey?: string;
  /** default volc.seedasr.auc */
  resourceId: string;
  /** submit | flash — defaults to submit */
  mode: 'submit' | 'flash';
}

export interface AsrWord {
  speakerId?: string;
  speakerName?: string;
  estimated?: boolean;
  text: string;
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  /** Visual / export paragraph break after this word (utterance boundary). */
  breakAfter?: boolean;
}

export interface AsrResult {
  words: AsrWord[];
  text: string;
  /** seconds */
  duration: number;
  /**
   * Indices into words[] of the last word of each utterance
   * (same info as breakAfter on those words).
   */
  utteranceEnds?: number[];
}

export type AudioInput =
  | { kind: 'data'; buffer: Buffer; filename: string }
  | { kind: 'url'; url: string; filename?: string };

export function readVolcCredsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VolcCreds | null {
  const apiKey =
    env.VOLC_APP_KEY?.trim() ||
    env.VOLC_API_KEY?.trim() ||
    '';
  if (!apiKey) return null;
  const accessKey = env.VOLC_ACCESS_KEY?.trim() || undefined;
  const resourceId =
    env.VOLC_RESOURCE_ID?.trim() || 'volc.seedasr.auc';
  const modeRaw = (env.VOLC_API_MODE?.trim() || 'submit').toLowerCase();
  const mode: 'submit' | 'flash' = modeRaw === 'flash' ? 'flash' : 'submit';
  return { apiKey, accessKey: accessKey || undefined, resourceId, mode };
}

function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return (m?.[1] || 'wav').toLowerCase();
}

export function audioFormatFromName(filename: string): string {
  const ext = extOf(filename);
  if (ext === 'wave') return 'wav';
  if (ext === 'opus') return 'ogg';
  if (['wav', 'mp3', 'ogg', 'spx', 'amr', 'aac', 'm4a'].includes(ext)) return ext;
  return ext === 'webm' ? 'ogg' : 'wav';
}

function formatFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    return audioFormatFromName(path || 'audio.mp3');
  } catch {
    return 'mp3';
  }
}

/**
 * Volc seedasr rejects some wav rates (e.g. 24kHz PCM). Normalize local uploads
 * to lossless 16kHz mono PCM WAV via ffmpeg when available.
 */
async function normalizeForVolc(
  buffer: Buffer,
  filename: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ff.status !== 0) {
    console.warn('[volc-asr] ffmpeg missing; uploading original bytes');
    return { buffer, filename };
  }
  const dir = mkdtempSync(join(tmpdir(), 'volc-asr-'));
  const ext = extOf(filename) || 'wav';
  const inPath = join(dir, `in.${ext}`);
  const outPath = join(dir, 'out.wav');
  try {
    writeFileSync(inPath, buffer);
    const conv = spawnSync(
      'ffmpeg',
      ['-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outPath],
      { encoding: 'utf8' },
    );
    if (conv.status !== 0) {
      console.warn('[volc-asr] ffmpeg convert failed; uploading original', conv.stderr?.slice(-200));
      return { buffer, filename };
    }
    return { buffer: readFileSync(outPath), filename: filename.replace(/\.[^.]+$/, '') + '.wav' };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}


/**
 * Prefer new-console X-Api-Key. If VOLC_ACCESS_KEY is set, also send old-console pair.
 */
function buildHeaders(creds: VolcCreds, requestId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': creds.apiKey,
    'X-Api-Resource-Id': creds.resourceId,
    'X-Api-Request-Id': requestId,
    'X-Api-Sequence': '-1',
  };
  if (creds.accessKey) {
    headers['X-Api-App-Key'] = creds.apiKey;
    headers['X-Api-Access-Key'] = creds.accessKey;
  }
  return headers;
}

interface VolcWordRaw {
  text?: string;
  start_time?: number;
  end_time?: number;
}

interface VolcUtteranceRaw {
  speaker_id?: string | number;
  speaker?: string | number;
  additions?: { speaker?: string | number; speaker_id?: string | number };
  text?: string;
  start_time?: number;
  end_time?: number;
  words?: VolcWordRaw[];
}

interface VolcResultBody {
  audio_info?: { duration?: number | string };
  result?: {
    text?: string;
    additions?: { duration?: string };
    utterances?: VolcUtteranceRaw[];
  };
  // some gateways nest under body
  body?: VolcResultBody;
}

function msToSec(ms: number): number {
  return ms / 1000;
}

/** Chinese + Latin sentence / clause punctuation Volc may inject into utterance.text. */
const PUNCT_CHARS = new Set(
  [...'，。！？、；：…—,.!?;:""\'\'“”‘’（）()【】《》〈〉'],
);

function isPunctChar(ch: string): boolean {
  return PUNCT_CHARS.has(ch);
}

function rawWordsFromUtterance(u: VolcUtteranceRaw): AsrWord[] {
  const out: AsrWord[] = [];
  if (u.words && u.words.length > 0) {
    for (const w of u.words) {
      const text = (w.text ?? '').trim();
      if (!text) continue;
      const start = msToSec(Number(w.start_time ?? u.start_time ?? 0));
      const end = msToSec(Number(w.end_time ?? w.start_time ?? u.end_time ?? 0));
      out.push({ text, start, end: Math.max(end, start), estimated: w.start_time == null || w.end_time == null });
    }
    return out;
  }
  // No word list: split utterance text (includes punct) evenly across span
  const text = (u.text ?? '').replace(/\s+/g, '');
  if (!text) return out;
  const uStart = msToSec(Number(u.start_time ?? 0));
  const uEnd = msToSec(Number(u.end_time ?? u.start_time ?? 0));
  const span = Math.max(uEnd - uStart, 0.05);
  const chars = [...text];
  const step = span / chars.length;
  chars.forEach((ch, i) => {
    const start = uStart + i * step;
    const end = uStart + (i + 1) * step;
    // Punct: zero-duration at boundary so pause finder won't treat it as speech
    if (isPunctChar(ch)) {
      out.push({ text: ch, start, end: start });
    } else {
      out.push({ text: ch, start, end, estimated: true });
    }
  });
  return out;
}

/**
 * Volc often returns punctuation only in utterance.text, not in words[].
 * Walk utterance text and insert missing punct as zero-duration tokens.
 */
export function mergePunctIntoWords(
  words: AsrWord[],
  utteranceText: string,
  utteranceStartSec: number,
): AsrWord[] {
  const uText = (utteranceText || '').replace(/\s+/g, '');
  if (!uText || words.length === 0) return words;

  // Already have punct in word list — keep as-is
  if (words.some((w) => [...w.text].some(isPunctChar))) return words;

  const chars = [...uText];
  const result: AsrWord[] = [];
  let wi = 0;
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i]!;

    if (wi < words.length) {
      const w = words[wi]!;
      const wChars = [...w.text];
      const slice = chars.slice(i, i + wChars.length).join('');
      if (slice === w.text) {
        result.push({ ...w });
        wi += 1;
        i += wChars.length;
        continue;
      }
    }

    if (isPunctChar(ch)) {
      const prev = result[result.length - 1];
      const next = wi < words.length ? words[wi] : undefined;
      const t = prev ? prev.end : (next?.start ?? utteranceStartSec);
      result.push({ text: ch, start: t, end: t });
      i += 1;
      continue;
    }

    // Misaligned non-punct char: skip it to avoid dropping remaining words
    i += 1;
  }

  while (wi < words.length) {
    result.push({ ...words[wi]! });
    wi += 1;
  }
  return result;
}

export function extractWords(body: VolcResultBody): {
  words: AsrWord[];
  utteranceEnds: number[];
} {
  const root = body.result ? body : body.body;
  const utterances = root?.result?.utterances ?? [];
  const out: AsrWord[] = [];
  const utteranceEnds: number[] = [];

  for (const u of utterances) {
    const uStart = msToSec(Number(u.start_time ?? 0));
    let chunk = rawWordsFromUtterance(u);
    chunk = mergePunctIntoWords(chunk, u.text ?? '', uStart);
    if (chunk.length === 0) continue;
    const speaker = u.additions?.speaker ?? u.additions?.speaker_id ?? u.speaker_id ?? u.speaker;
    const id = typeof speaker === 'string' || typeof speaker === 'number' ? String(speaker).trim() : '';
    if (id && !['-1', 'unknown', 'null', 'undefined'].includes(id.toLowerCase())) chunk = chunk.map(w => ({...w, speakerId: id}));
    out.push(...chunk);
    const lastIdx = out.length - 1;
    out[lastIdx] = { ...out[lastIdx]!, breakAfter: true };
    utteranceEnds.push(lastIdx);
  }
  return { words: out, utteranceEnds };
}

function durationSeconds(body: VolcResultBody, words: AsrWord[]): number {
  const root = body.result ? body : body.body;
  const raw =
    root?.audio_info?.duration ??
    root?.result?.additions?.duration ??
    null;
  if (raw != null && raw !== '') {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return ms / 1000;
  }
  if (words.length > 0) return words[words.length - 1]!.end;
  return 0;
}

function resultText(body: VolcResultBody, words: AsrWord[]): string {
  const root = body.result ? body : body.body;
  const fromApi = root?.result?.text?.trim();
  if (fromApi) return fromApi;
  // Rebuild with breaks from our word list
  let out = '';
  for (const w of words) {
    out += w.text;
    if (w.breakAfter) out += '\n';
  }
  return out.trim();
}

export class VolcAsrError extends Error {
  constructor(
    message: string,
    public statusCode?: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'VolcAsrError';
  }
}

const MAX_BYTES = 512 * 1024 * 1024; // standard edition
const SOFT_DATA_BYTES = 40 * 1024 * 1024; // base64 payload caution

const DEFAULT_MAX_POLLS = 90; // 90 * 2s = 3 min
const DEFAULT_POLL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mapFailHint(statusCode: string, apiMessage: string): string {
  if (statusCode === '45000001') return '请求参数无效';
  if (statusCode === '45000151') return '音频格式不支持（请用 wav / mp3 / ogg / m4a）';
  if (statusCode === '55000031') return '服务繁忙，请稍后重试';
  if (
    statusCode === '45000010' ||
    /grant|auth|token|permission|unauthorized/i.test(apiMessage)
  ) {
    return '密钥无效或未开通豆包录音文件识别 2.0（volc.seedasr.auc），请检查 VOLC_APP_KEY';
  }
  return apiMessage || '识别失败';
}

async function readJsonSafe(res: Response): Promise<VolcResultBody> {
  const raw = await res.text();
  if (!raw || raw === '{}') return {};
  try {
    return JSON.parse(raw) as VolcResultBody;
  } catch {
    throw new VolcAsrError(
      `火山引擎返回非 JSON（HTTP ${res.status}）`,
      String(res.status),
      res.status,
    );
  }
}

function buildAudioPayload(input: AudioInput): {
  audio: Record<string, string>;
  label: string;
} {
  if (input.kind === 'url') {
    const format = formatFromUrl(input.url);
    return {
      audio: { url: input.url, format },
      label: `url ${input.url.slice(0, 80)}`,
    };
  }
  if (input.buffer.length === 0) {
    throw new VolcAsrError('空音频文件', '45000002', 400);
  }
  if (input.buffer.length > MAX_BYTES) {
    throw new VolcAsrError(
      `文件超过 512MB 限制（当前 ${(input.buffer.length / 1024 / 1024).toFixed(1)}MB）`,
      '45000001',
      413,
    );
  }
  if (input.buffer.length > SOFT_DATA_BYTES) {
    console.warn(
      `[volc-asr] ${(input.buffer.length / 1024 / 1024).toFixed(1)}MB base64 submit may be slow; prefer a public URL`,
    );
  }
  const format = audioFormatFromName(input.filename);
  return {
    audio: {
      data: input.buffer.toString('base64'),
      format,
    },
    label: `${input.filename} ${(input.buffer.length / 1024).toFixed(1)}KB`,
  };
}

function finalizeBody(parsed: VolcResultBody): AsrResult {
  const { words, utteranceEnds } = extractWords(parsed);
  const text = resultText(parsed, words);
  const duration = durationSeconds(parsed, words);
  if (words.length === 0 && !text) {
    throw new VolcAsrError(
      '识别成功但未返回字级结果，请确认提交时 show_utterances=true',
      '20000000',
      502,
    );
  }
  if (words.length === 0 && text) {
    const chars = [...text.replace(/\s+/g, '')];
    const step = duration > 0 ? duration / Math.max(chars.length, 1) : 0.2;
    const fallback = chars.map((ch, i) => ({
      text: ch,
      estimated: true,
      start: i * step,
      end: isPunctChar(ch) ? i * step : (i + 1) * step,
    }));
    return {
      words: fallback,
      text,
      duration: duration || fallback.at(-1)?.end || 0,
      utteranceEnds: [],
    };
  }
  return { words, text, duration, utteranceEnds };
}

export interface AsrProgressEvent {
  phase: 'normalize' | 'submit' | 'poll' | 'done';
  /** 0–100 rough progress for UI. */
  percent: number;
  poll?: number;
  maxPolls?: number;
}

export type AsrProgressCallback = (ev: AsrProgressEvent) => void;

/** Standard 2.0: submit then poll query with the SAME X-Api-Request-Id. */
export async function recognizeSubmitQuery(
  input: AudioInput,
  creds: VolcCreds,
  opts?: { maxPolls?: number; pollMs?: number; onProgress?: AsrProgressCallback },
): Promise<AsrResult> {
  const onProgress = opts?.onProgress;
  let prepared = input;
  if (input.kind === 'data') {
    onProgress?.({ phase: 'normalize', percent: 4 });
    const norm = await normalizeForVolc(input.buffer, input.filename);
    prepared = { kind: 'data', buffer: norm.buffer, filename: norm.filename };
  }
  onProgress?.({ phase: 'submit', percent: 8 });
  const requestId = randomUUID();
  const headers = buildHeaders(creds, requestId);
  const { audio, label } = buildAudioPayload(prepared);

  const submitBody = {
    user: { uid: 'podcast-cutter' },
    audio,
    request: {
      model_name: 'bigmodel',
      enable_itn: false, // Keep spoken forms for acoustic alignment (e.g. 二零二六).
      enable_punc: true,
      enable_ddc: false,
      ...speakerRecognitionOptions(prepared),
      language: 'zh-CN',
    },
  };

  console.log(
    `[volc-asr] submit ${label} resource=${creds.resourceId} reqId=${requestId}`,
  );

  const submitRes = await fetch(SUBMIT_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(submitBody),
  });

  const submitCode = submitRes.headers.get('X-Api-Status-Code') ?? '';
  const submitMsg = submitRes.headers.get('X-Api-Message') ?? '';
  const submitLog = submitRes.headers.get('X-Tt-Logid') ?? '';
  // Body is often {}; task id is our X-Api-Request-Id
  await readJsonSafe(submitRes);

  // Success submit: 20000000, or empty code with HTTP 200 (some gateways)
  const submitOk =
    submitCode === '20000000' ||
    (!submitCode && submitRes.ok) ||
    submitMsg.toUpperCase() === 'OK';

  if (!submitOk) {
    // If base64 rejected, hint URL path
    const hint = mapFailHint(submitCode, submitMsg);
    const dataHint =
      input.kind === 'data' &&
      (/url|参数|invalid|audio/i.test(submitMsg) || submitCode === '45000001')
        ? '；若标准版不接受本地 base64，请改用公网音频 URL 转写'
        : '';
    console.error('[volc-asr] submit fail', {
      submitCode,
      submitMsg,
      submitLog,
      http: submitRes.status,
    });
    throw new VolcAsrError(
      `${hint}${dataHint}${submitCode ? ` (${submitCode})` : ''}${submitLog ? ` logid=${submitLog}` : ''}`,
      submitCode || String(submitRes.status),
      submitRes.status >= 400 ? submitRes.status : 502,
    );
  }

  const maxPolls = opts?.maxPolls ?? DEFAULT_MAX_POLLS;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;

  for (let i = 0; i < maxPolls; i++) {
    // Map polls into ~10–92% so the UI can show xx% while Volc works.
    const pct = Math.min(92, 10 + Math.round(((i + 1) / maxPolls) * 82));
    onProgress?.({ phase: 'poll', percent: pct, poll: i + 1, maxPolls });
    await sleep(pollMs);
    const queryRes = await fetch(QUERY_URL, {
      method: 'POST',
      headers, // SAME request id
      body: '{}',
    });
    const qCode = queryRes.headers.get('X-Api-Status-Code') ?? '';
    const qMsg = queryRes.headers.get('X-Api-Message') ?? '';
    const qLog = queryRes.headers.get('X-Tt-Logid') ?? '';
    const parsed = await readJsonSafe(queryRes);

    // Still processing
    if (
      qCode === '20000001' ||
      qCode === '20000002' ||
      (!qCode && !parsed.result && queryRes.ok)
    ) {
      if (i === 0 || i % 5 === 0) {
        console.log(`[volc-asr] polling… #${i + 1} code=${qCode || 'pending'}`);
      }
      continue;
    }

    if (qCode === '20000000' || parsed.result) {
      console.log(`[volc-asr] query done after ${i + 1} polls`);
      onProgress?.({ phase: 'done', percent: 100, poll: i + 1, maxPolls });
      return finalizeBody(parsed);
    }

    if (qCode === '20000003') {
      throw new VolcAsrError('音频为静音，无法识别', qCode, 422);
    }

    // Empty body without status → keep polling a bit more
    if (!qCode && Object.keys(parsed).length === 0) continue;

    const hint = mapFailHint(qCode, qMsg);
    console.error('[volc-asr] query fail', { qCode, qMsg, qLog, http: queryRes.status });
    throw new VolcAsrError(
      `${hint}${qCode ? ` (${qCode})` : ''}${qLog ? ` logid=${qLog}` : ''}`,
      qCode || String(queryRes.status),
      queryRes.status >= 400 ? queryRes.status : 502,
    );
  }

  throw new VolcAsrError(
    `转写超时（已轮询 ${maxPolls} 次，约 ${((maxPolls * pollMs) / 1000).toFixed(0)}s）。长音频请稍后再试或用公网 URL`,
    'TIMEOUT',
    504,
  );
}

/** Official podcast config: long recordings use clustering to avoid over-splitting voices. */
export function speakerRecognitionOptions(input: AudioInput) {
  let duration = Infinity;
  if (input.kind === 'data') {
    const b = input.buffer;
    if (b.length >= 12 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WAVE') {
      let bytesPerSecond = 0;
      for (let at=12; at+8<=b.length;) {
        const size=b.readUInt32LE(at+4), tag=b.toString('ascii',at,at+4);
        if (tag==='fmt ' && size>=16 && at+24<=b.length) bytesPerSecond=b.readUInt32LE(at+16);
        if (tag==='data' && bytesPerSecond) { duration=Math.min(size,b.length-at-8)/bytesPerSecond; break; }
        if (size>b.length-at-8) break;
        at+=8+size+(size%2);
      }
    }
  }
  return {enable_speaker_info:true,show_utterances:true,ssd_version:'200',ssd_mode:duration<=180?0:1};
}

/** Optional flash path if VOLC_API_MODE=flash (turbo resource). */
const FLASH_URL =
  'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';

export async function recognizeFlash(
  input: AudioInput,
  creds: VolcCreds,
): Promise<AsrResult> {
  let prepared = input;
  if (input.kind === 'data') {
    const norm = await normalizeForVolc(input.buffer, input.filename);
    prepared = { kind: 'data', buffer: norm.buffer, filename: norm.filename };
  }
  const requestId = randomUUID();
  const headers = buildHeaders(creds, requestId);
  const { audio, label } = buildAudioPayload(prepared);
  console.log(`[volc-asr] flash ${label} resource=${creds.resourceId}`);
  const res = await fetch(FLASH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      user: { uid: 'podcast-cutter' },
      audio,
      request: {
        model_name: 'bigmodel',
        enable_itn: false, // Keep spoken forms for acoustic alignment (e.g. 二零二六).
        enable_punc: true,
        enable_ddc: false,
        show_utterances: true,
        enable_speaker_info: true,
        language: 'zh-CN',
      },
    }),
  });
  const statusCode = res.headers.get('X-Api-Status-Code') ?? '';
  const apiMessage = res.headers.get('X-Api-Message') ?? '';
  const logId = res.headers.get('X-Tt-Logid') ?? '';
  const parsed = await readJsonSafe(res);
  if (statusCode === '20000000' || parsed.result) {
    return finalizeBody(parsed);
  }
  throw new VolcAsrError(
    `${mapFailHint(statusCode, apiMessage)}${statusCode ? ` (${statusCode})` : ''}${logId ? ` logid=${logId}` : ''}`,
    statusCode || String(res.status),
    res.status >= 400 ? res.status : 502,
  );
}

export async function recognize(
  input: AudioInput,
  creds: VolcCreds,
  opts?: { maxPolls?: number; pollMs?: number; onProgress?: AsrProgressCallback },
): Promise<AsrResult> {
  if (creds.mode === 'flash') {
    opts?.onProgress?.({ phase: 'submit', percent: 30 });
    const r = await recognizeFlash(input, creds);
    opts?.onProgress?.({ phase: 'done', percent: 100 });
    return r;
  }
  return recognizeSubmitQuery(input, creds, opts);
}
