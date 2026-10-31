import type { Clip, Word } from './types';
import { speakerParagraphs } from './speakers';

const SENTENCE_END = /^[。！？!?]$/;

/** Join remaining (non-deleted) words into a clean Chinese transcript with paragraphs. */
export function buildTranscriptText(words: Word[]): string {
  const paragraphs: Array<{text:string; speakerId?:string; speakerName?:string}> = [];
  let line = '', speakerId: string | undefined, speakerName: string | undefined;
  const flush = () => { if (line.trim()) paragraphs.push({text:line.trim(),speakerId,speakerName}); line=''; };
  for (const w of words) {
    if (!w.deleted) {
      if (w.speakerId !== speakerId) flush();
      speakerId=w.speakerId; speakerName=w.speakerName;
      line += w.text;
    }
    if (w.breakAfter || (!w.deleted && SENTENCE_END.test(w.text))) flush();
  }
  flush();
  return speakerParagraphs(paragraphs);
}

/** Concatenate all clips' transcripts in track order, separated by a blank line. */
export function buildMultiClipTranscript(clips: Clip[]): string {
  return clips
    .map((c) => buildTranscriptText(c.words))
    .filter(Boolean)
    .join('\n\n');
}

export function exportTxt(words: Word[], basename = 'transcript'): void {
  const text = buildTranscriptText(words);
  const blob = new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, `${basename}.txt`);
}

export function exportMd(words: Word[], basename = 'transcript'): void {
  const text = buildTranscriptText(words);
  const md = `# 播客文字稿\n\n${text}\n`;
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  triggerDownload(blob, `${basename}.md`);
}

export function exportMultiTxt(clips: Clip[], basename = 'transcript'): void {
  const text = buildMultiClipTranscript(clips);
  const blob = new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, `${basename}.txt`);
}

export function exportMultiMd(clips: Clip[], basename = 'transcript'): void {
  const parts = clips
    .map((c, i) => {
      const body = buildTranscriptText(c.words);
      if (!body) return '';
      return clips.length > 1 ? `## ${i + 1}. ${c.name}\n\n${body}` : body;
    })
    .filter(Boolean)
    .join('\n\n');
  const md = `# 播客文字稿\n\n${parts}\n`;
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  triggerDownload(blob, `${basename}.md`);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
