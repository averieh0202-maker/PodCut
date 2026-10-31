/** B1: deleted word intervals must leave ranges that exclude that audio. */
function removeRange(ranges, cutStart, cutEnd) {
  if (cutEnd <= cutStart) return ranges.map((r) => ({ ...r }));
  const out = [];
  for (const r of ranges) {
    if (cutEnd <= r.start || cutStart >= r.end) {
      out.push({ ...r });
      continue;
    }
    if (cutStart > r.start) out.push({ start: r.start, end: Math.min(cutStart, r.end) });
    if (cutEnd < r.end) out.push({ start: Math.max(cutEnd, r.start), end: r.end });
  }
  return out.filter((r) => r.end - r.start > 1e-4);
}

function covers(ranges, t) {
  return ranges.some((r) => t >= r.start && t < r.end);
}

const duration = 10;
let ranges = [{ start: 0, end: duration }];
// delete word [1.0, 1.5] with expand to neighbors at 0.8 and 2.0
ranges = removeRange(ranges, 0.8, 2.0);
const mid = 1.25;
if (covers(ranges, mid)) {
  console.error('FAIL: deleted midpoint still covered', ranges);
  process.exit(1);
}
if (!covers(ranges, 0.5) || !covers(ranges, 2.5)) {
  console.error('FAIL: kept neighbors lost', ranges);
  process.exit(1);
}
// HTML fallback gate: edited => not simple full clip
const isSimple = ranges.length === 1 && ranges[0].start <= 1e-4 && Math.abs(ranges[0].end - duration) < 0.05;
if (isSimple) {
  console.error('FAIL: still looks like simple full clip');
  process.exit(1);
}
console.log('ok b1-ranges', ranges);
