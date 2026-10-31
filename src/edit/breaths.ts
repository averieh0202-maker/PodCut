import type { Word, TimeRange } from './types';
import { envelope, type AcousticInput } from './acoustics';
import { isPunctText } from './alignment';
import type { PauseCandidate } from './pauses';

const cache=new WeakMap<Float32Array,{key:string;sampleRate:number;channels:Float32Array[];parts:TimeRange[]}>();
/** Conservative opt-in breath candidates. Aperiodic, low-energy noise must be
 * enclosed by quiet edges and outside word exclusion zones on every channel.
 * This is a heuristic, not a trained breath classifier. */
export function detectBreaths(words:Word[],ranges:TimeRange[],input:AcousticInput,duration:number):PauseCandidate[] {
  if(input.sampleRate<4000)return [];
  const spoken=words.filter(w=>!isPunctText(w.text)).sort((a,b)=>a.start-b.start);
  if(!spoken.some(w=>w.manualBoundary||w.alignmentSource))return [];
  const channels=input.channels?.length ? input.channels : [input.channel];
  const key=`${duration};`+spoken.map(w=>`${w.start},${w.end},${!!(w.manualBoundary||w.alignmentSource)}`).join(';');
  const saved=cache.get(input.channel);
  let parts=saved?.key===key&&saved.sampleRate===input.sampleRate&&saved.channels.length===channels.length&&saved.channels.every((c,i)=>c===channels[i]) ? saved.parts : undefined;
  if(!parts) {
    parts=[];
    const {rms,step,quiet}=envelope(input);
    // Smooth only the activity envelope: single 5ms noise fluctuations must
    // not fragment an inhalation or invalidate its quiet edges. Voice checks
    // below still use the original samples on every channel.
    const activity=Float32Array.from(rms,(_,i)=>{
      let sum=0,count=0;
      for(let j=Math.max(0,i-2);j<=Math.min(rms.length-1,i+2);j++){sum+=rms[j]!**2;count++;}
      return Math.sqrt(sum/count);
    });
    const ordered=Float32Array.from(rms).sort();
    // Close-mic inhalations can approach voiced RMS; voicing and quiet-edge
    // checks, rather than a 40% loudness ceiling, distinguish them from speech.
    const cap=Math.min(.15,(ordered[Math.floor(ordered.length*.9)]??0)*.85);
    const edge=Math.max(1,Math.ceil(.02/step));
    for(let wi=0;wi+1<spoken.length;wi++) {
      const prev=spoken[wi]!,next=spoken[wi+1]!;
      const prevTrusted=!!(prev.manualBoundary||prev.alignmentSource),nextTrusted=!!(next.manualBoundary||next.alignmentSource);
      if(!prevTrusted&&!nextTrusted)continue;
      // A missing alignment tag on an English token must not suppress the
      // entire following gap. Keep a wider exclusion zone at that edge.
      const lo=Math.ceil((prev.end+(prevTrusted?(/[a-z]/i.test(prev.text)?.06:.025):.12))/step), hi=Math.floor((next.start-(nextTrusted?(/[a-z]/i.test(next.text)?.06:.025):.12))/step);
      if(hi<=lo)continue;
      // Room tone varies within a recording. Use the quiet part of this gap
      // as a local floor; the energy cap still excludes speech-level events.
      const gap=Float32Array.from(activity.slice(lo,hi)).sort();
      const localQuiet=Math.max(quiet,Math.min(.003,cap*.35,(gap[Math.floor(gap.length*.2)]??0)*2+.00015));
      // Inhalation often has a fading second lobe. Keep sub-150ms dips
      // inside one event; every lobe still passes the original voice checks.
      const bridge=Math.max(1,Math.ceil(.15/step));
      for(let f=lo;f<hi;) {
        if((activity[f]??0)<=localQuiet){f++;continue;}
        // A trailing syllable can touch the start of the search window.
        // Skip it until a quiet edge, rather than bridge it into the breath
        // and reject both as one event.
        if(f-edge<lo||!Array.from(activity.slice(f-edge,f)).every(v=>v<=localQuiet)){f++;continue;}
        const first=f;
        let lastActive=f;
        while(f<hi) {
          if((activity[f]??0)>localQuiet)lastActive=f;
          else if(f-lastActive>bridge)break;
          f++;
        }
        f=lastActive+1;
        const last=f,length=(last-first)*step;
        if(length<.06||length>1.2||first-edge<lo||last+edge>hi)continue;
        if(!Array.from(rms.slice(first,last)).every(v=>v<=cap))continue;
        if(!Array.from(activity.slice(first-edge,first)).every(v=>v<=localQuiet)||!Array.from(activity.slice(last,last+edge)).every(v=>v<=localQuiet))continue;
        let valid=true;
        for(const channel of channels) {
          for(let t=first*step;t+.04<=last*step;t+=.04) {
            const stride=Math.max(1,Math.round(input.sampleRate/8000)),sr=input.sampleRate/stride;
            const start=Math.round(t*input.sampleRate), n=Math.round(.04*sr);
            const frame=Float32Array.from({length:n},(_,i)=>channel[start+i*stride]??0);
            let energy=0,crossings=0;for(let i=0;i<n;i++){energy+=frame[i]!**2;if(i&&frame[i]!*frame[i-1]!<0)crossings++;}
            if(Math.sqrt(energy/n)<=quiet)continue;
            if(crossings/n<.035){valid=false;break;}
            let periodicity=0;
            for(let lag=Math.floor(sr/400);lag<=Math.ceil(sr/80);lag+=2) {
              let dot=0,a=0,b=0;for(let i=lag;i<n;i++){dot+=frame[i]!*frame[i-lag]!;a+=frame[i]!**2;b+=frame[i-lag]!**2;}
              periodicity=Math.max(periodicity,dot/Math.sqrt(a*b+1e-20));
            }
            if(periodicity>.55){valid=false;break;}
          }
          if(!valid)break;
        }
        if(valid){let a=first,b=last;while(a>lo&&(activity[a-1]??0)<=localQuiet)a--;while(b<hi&&(activity[b]??0)<=localQuiet)b++;parts.push({start:a*step,end:Math.min(duration,b*step)});}
      }
    }
    cache.set(input.channel,{key,sampleRate:input.sampleRate,channels:[...channels],parts});
  }
  return parts.flatMap((p,i)=>ranges.map((r,j)=>({id:`breath-${i}-${j}`,start:Math.max(r.start,p.start),end:Math.min(r.end,p.end)})).filter(p=>p.end-p.start>=.02-1e-7).map(p=>({...p,breath:true,duration:p.end-p.start,cut:{start:p.start+.01,end:p.end-.01}})));
}
