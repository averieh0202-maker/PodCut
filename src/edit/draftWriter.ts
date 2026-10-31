/** One writer, monotonically increasing edit versions. Edits arriving during
 * an upload get their own commit before flush resolves. A failed commit stays dirty. */
export class DraftWriter {
  private edited = 0;
  private saved = 0;
  private task: Promise<void> | null = null;
  constructor(private readonly write: () => Promise<void>) {}
  get dirty() { return this.edited !== this.saved; }
  get saving() { return this.task !== null; }
  markDirty() { this.edited++; }
  flush(): Promise<void> {
    if (this.task) return this.task;
    this.task = (async () => {
      while (this.dirty) {
        const version = this.edited;
        await this.write();
        this.saved = version;
      }
    })().finally(() => { this.task = null; });
    return this.task;
  }
}
