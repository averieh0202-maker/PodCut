import type { Word } from './types';
import { isPunctText } from './alignment';
/** Always expose individual Han characters. Multi-character ASR spans only
 * provide estimated character timing; make that uncertainty visible. */
export function characterWords(words: Word[]): Word[] {
  return words.flatMap(w => {
    const tokens = w.text.match(/\p{Script=Han}|[\p{P}]|[^\p{Script=Han}\p{P}]+/gu) ?? [w.text];
    if (tokens.length <= 1) return [w];
    const count = tokens.filter(t => !isPunctText(t)).length;
    let index = 0;
    return tokens.map((text, n) => {
      const start = w.start + (w.end - w.start) * index / Math.max(1, count);
      if (!isPunctText(text)) index++;
      const end = w.start + (w.end - w.start) * index / Math.max(1, count);
      return { ...w, id: n === 0 ? w.id : `${w.id}-c${n}`, text, start, end,
        estimated: count > 1 || w.estimated,
        breakAfter: n === tokens.length - 1 && w.breakAfter };
    });
  });
}
