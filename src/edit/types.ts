/** Word with timestamps in original audio seconds (within its clip). */
export interface Word {
  id: string;
  text: string;
  start: number;
  end: number;
  deleted: boolean;
  /** Recording-scoped speaker identity; independent of editable display name. */
  speakerId?: string;
  speakerName?: string;
  /** Character timing interpolated from a larger ASR span. */
  estimated?: boolean;
  /** Persisted review suggestion; never deletes audio automatically. */
  duplicateReason?: string;
  roughCutReason?: string;
  manualBoundary?: boolean;
  /** Acoustic forced alignment; never set for interpolation or energy snapping. */
  alignmentSource?: 'qwen3' | 'fa-zh';
  alignmentReview?: boolean;
  /** Exact original audio pieces removed for this token. */
  removedAudio?: TimeRange[];
  joinedCut?: boolean;
  /** Internal breath/gap audio is owned by this contiguous deletion. */
  continuousCut?: boolean;
  /** Paragraph / utterance break after this word (UI + export). */
  breakAfter?: boolean;
}

/** Kept range on the original audio timeline (seconds). */
export interface TimeRange {
  start: number;
  end: number;
}

/** One pause interval removed by clear-pauses — can be restored singly (B8). */
export interface ClearedPause {
  id: string;
  start: number;
  end: number;
}

/** One audio segment on the concat track. */
export interface Clip {
  legacyDeletionRepairVersion?: number;
  id: string;
  name: string;
  /** Buffer currently used for playback/export (may be denoised). */
  buffer: AudioBuffer;
  /** Untouched decode; FX toggles restore/rebuild from this. */
  cleanBuffer: AudioBuffer;
  duration: number;
  words: Word[];
  ranges: TimeRange[];
  /** Full source segments in edit order, including temporarily deleted audio. */
  audioOrder?: TimeRange[];
  /** Mild denoise applied (rebuilds from cleanBuffer). */
  gainDb?: number;
  denoised: boolean;
  /** Light voice beautify applied (rebuilds from cleanBuffer). */
  beautified: boolean;
  /** Pauses removed by clear-pauses; amber marks (B8). */
  clearedPauses?: ClearedPause[];
  manualPauses?: Array<{id:string;start:number;end:number;sourceStart:number;sourceEnd:number}>;
  /** Original import file bytes for IndexedDB draft restore (B2). */
  sourceBlob?: Blob;
  sourceMime?: string;
  /** True when clean/play buffers no longer match a fresh decode of sourceBlob (e.g. paste). */
  bufferDirty?: boolean;
}

/** Background bed under speech, or transition stinger between speech. */
export type MusicKind = 'bed' | 'stinger';

export interface MusicPlacement {
  /** Music plays alone for this many seconds before anchored speech starts. */
  leadInSec?: number;
  id: string;
  kind: MusicKind;
  name: string;
  /** Optional link back to the reusable library. */
  libraryId?: string;
  buffer: AudioBuffer;
  /** Placement gain in dB (bed default −15, stinger default −3). */
  gainDb: number;
  /** Anchor clip id. */
  clipId: string;
  /** Anchor original-audio time within the clip (word boundary). */
  originalTime: number;
  /** Optional word id for UI anchoring (which 字 starts this audio). */
  wordId?: string;
  /** Explicit edge: survives subsequent manual/acoustic boundary edits. */
  anchorSide?: 'before' | 'after';
  /** Seconds into the source buffer where playback starts (default 0). */
  inPoint?: number;
  /** Seconds into the source buffer where playback ends (default buffer.duration). */
  outPoint?: number;
  /** Fade-in seconds at placement start (bed default 0.5, stinger shorter). */
  fadeInSec?: number;
  /** Fade-out seconds at placement end (bed default 0.8, stinger shorter). */
  fadeOutSec?: number;
  /** Optional original bytes for draft restore when not in SFX library. */
  sourceBlob?: Blob;
  sourceMime?: string;
}

export interface ProjectState {
  /** Pitch-preserving speech tempo for preview and export; music stays 1x. */
  speechRate?: number;
  clips: Clip[];
  /** Master gain in dB (−24 … +36), default 0. Convert with dbToLinear for playback/export. */
  gainDb: number;
  /** Basename for exports. */
  audioName: string;
  /** Music / SFX placements on the edit timeline. */
  music: MusicPlacement[];
}

export interface TranscriptFile {
  language?: string;
  audio?: string;
  duration: number;
  text: string;
  words: Array<{ text: string; start: number; end: number; breakAfter?: boolean; speakerId?: string; speakerName?: string }>;
  note?: string;
}

/** Undo snapshot scoped to one clip. */
export interface Snapshot {
  clipId: string;
  words: Word[];
  ranges: TimeRange[];
  /** Full source segments in edit order, including temporarily deleted audio. */
  audioOrder?: TimeRange[];
  /** Original clip duration (buffer may keep unused tail after paste undo). */
  duration?: number;
  clearedPauses?: ClearedPause[];
  manualPauses?: Array<{id:string;start:number;end:number;sourceStart:number;sourceEnd:number}>;
}

/** One clip's schedule for the audio engine. */
export interface ClipSchedule {
  buffer: AudioBuffer;
  ranges: TimeRange[];
  /** Full source segments in edit order, including temporarily deleted audio. */
  audioOrder?: TimeRange[];
}
