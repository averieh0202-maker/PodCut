/** Keep the user's gain everywhere except brief peaks that exceed PCM range.
 * Disable FFmpeg auto makeup gain and compensate lookahead latency explicitly. */
export function exportLimiter(peak:number,frames:number):string {
 if(!Number.isFinite(peak)||!Number.isInteger(frames)||frames<1)throw Error('Invalid export dimensions');
 return peak>1?`alimiter=limit=0.98:level=false:attack=5:release=50:latency=true,apad,atrim=end_sample=${frames}`:'anull';
}
