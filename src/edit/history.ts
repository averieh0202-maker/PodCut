import type { Snapshot } from './types';
import { cloneRanges } from './timeline';

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return {
    clipId: snapshot.clipId,
    words: snapshot.words.map(word => ({ ...word, ...(word.removedAudio ? { removedAudio: cloneRanges(word.removedAudio) } : {}) })),
    ranges: cloneRanges(snapshot.ranges),
    audioOrder: snapshot.audioOrder?.map(r => ({ ...r })),
    duration: snapshot.duration,
    clearedPauses: snapshot.clearedPauses?.map(p => ({ ...p })),
    manualPauses: snapshot.manualPauses?.map(p => ({ ...p })),
  };
}

export class UndoStack {
  private stack: Snapshot[] = [];
  private future: Snapshot[] = [];
  constructor(private limit = 40) {}

  /** A new edit starts a new branch; older redo states no longer apply. */
  push(snapshot: Snapshot): void {
    this.stack.push(cloneSnapshot(snapshot));
    if (this.stack.length > this.limit) this.stack.shift();
    this.future = [];
  }

  pop(current?: Snapshot): Snapshot | null {
    const snapshot = this.stack.pop();
    if (!snapshot) return null;
    if (current) this.future.push(cloneSnapshot(current));
    return snapshot;
  }

  redo(current: Snapshot): Snapshot | null {
    const snapshot = this.future.pop();
    if (!snapshot) return null;
    this.stack.push(cloneSnapshot(current));
    if (this.stack.length > this.limit) this.stack.shift();
    return snapshot;
  }

  get undoClipId(): string | undefined { return this.stack.at(-1)?.clipId; }
  get redoClipId(): string | undefined { return this.future.at(-1)?.clipId; }
  get canUndo(): boolean { return this.stack.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  clear(): void { this.stack = []; this.future = []; }
}
