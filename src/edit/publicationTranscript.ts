import type { EpisodeSegment } from './episodeTimeline';
import { speakerParagraphs } from './speakers';

export function validatePublicationSegments(segments: EpisodeSegment[]): void {
  if (!Array.isArray(segments) || !segments.length || segments.length > 4000 ||
      segments.some(s => !s || typeof s.text !== 'string' || typeof s.clipId !== 'string' ||
        !Number.isFinite(s.start) || s.start < 0) ||
      segments.reduce((n, s) => n + s.text.length, 0) > 150000) {
    throw Error('无效或过大的剪后文字稿');
  }
}

/** The intro copies body excerpts; omit those copies, not repeated speech in the body. */
export function publicationBodySegments(segments: EpisodeSegment[]): EpisodeSegment[] {
  validatePublicationSegments(segments);
  const body = segments.filter(s => !s.clipId.startsWith('teaser-'));
  return body.length ? body : segments;
}

/** Format the actual kept words without a model, paraphrasing, or factual substitutions. */
export function buildPublicationTranscript(segments: EpisodeSegment[]): string {
  const text = speakerParagraphs(publicationBodySegments(segments).map(s => ({...s,scope:s.clipId})));
  if (!text) throw Error('没有可导出的剪后文字');
  return `# 播客长文稿\n\n${text}\n`;
}
