type NoticeOptions = {
  duration?: number;
  link?: { href: string; label: string; download?: string };
};

/** One quiet status slot in the fixed editing toolbar. Zero duration means in progress. */
export class ToolbarNotice {
  private timer = 0;
  private duration = 0;
  private hovered = false;

  constructor(private element: HTMLElement) {
    element.addEventListener('mouseenter', () => {
      this.hovered = true;
      window.clearTimeout(this.timer);
    });
    element.addEventListener('mouseleave', () => { this.hovered = false; this.schedule(); });
    element.addEventListener('focusin', () => window.clearTimeout(this.timer));
    element.addEventListener('focusout', () => this.schedule());
  }

  show(message: string, options: NoticeOptions = {}): void {
    window.clearTimeout(this.timer);
    this.duration = options.duration ?? 5000;
    const text = document.createElement('span');
    text.className = 'toolbar-notice-text';
    text.textContent = message;
    this.element.replaceChildren(text);
    if (options.link) {
      const link = document.createElement('a');
      link.href = options.link.href;
      link.textContent = options.link.label;
      if (options.link.download) link.download = options.link.download;
      this.element.append(link);
    }
    this.element.hidden = false;
    this.schedule();
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    if (!this.duration || this.hovered || this.element.contains(document.activeElement)) return;
    this.timer = window.setTimeout(() => { this.element.hidden = true; }, this.duration);
  }
}
