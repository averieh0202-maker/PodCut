import { ContinuousResampler, SpeechPitchCorrector } from './continuousResampler';
import type { MixSchedule } from './mixSchedule';
import { speechTempoMap } from './speechTempo';
import { spliceGain } from './splice';
import { GAIN_LINEAR_MAX } from './gain';

/** Render the same rate-change + pitch-correction chain used by preview.
 * CLI fallback only; browser exports render the complete nativeMixExport graph.
 * A streaming source resampler provides source-rate changes here.
 * Keep processing continuous across edit seams; reset at inserted music gaps.
 */
export async function renderTempoSpeech(mix:MixSchedule, speed:number, sampleRate:number, outs:Float32Array[]) {
  const map=speechTempoMap(mix,speed);
  const sources=mix.sources.filter(s=>s.role==='speech').sort((a,b)=>a.whenEdit-b.whenEdit);
  const groups:typeof sources[]=[];
  for(const s of sources){const g=groups.at(-1),last=g?.at(-1);if(last && Math.abs(last.whenEdit+last.duration-s.whenEdit)<1/sampleRate)g!.push(s);else groups.push([s]);}
  let batches=0;
  for(const group of groups){
    const first=group[0]!,last=group.at(-1)!;
    const start=Math.round(map.toWall(first.whenEdit)*sampleRate);
    const count=Math.round((last.whenEdit+last.duration-first.whenEdit)/speed*sampleRate);
    // Headless fallback for local CLI rendering; browser exports never use it.
    // AudioParams in preview are float32; use the same effective rate here.
    const processingSpeed=Math.fround(speed);
    const sourceRate=new ContinuousResampler(processingSpeed);
    const stretch=new SpeechPitchCorrector(sampleRate,1/processingSpeed);
    let transfer=new Float32Array(0);
    let written=0;
    const drain=()=>{
      sourceRate.process();
      const available=sourceRate.outputBuffer.frameCount;
      if(available){
        if(transfer.length<available*2)transfer=new Float32Array(available*2);
        sourceRate.outputBuffer.extract(transfer,0,available);sourceRate.outputBuffer.receive(available);
        stretch.inputBuffer.putSamples(transfer,0,available);
      }
      stretch.process();
      const n=stretch.outputBuffer!.frameCount;
      if(!n)return;
      const pcm=new Float32Array(n*2);stretch.outputBuffer!.extract(pcm,0,n);stretch.outputBuffer!.receive(n);
      const take=Math.min(n,count-written);
      for(let i=0;i<take;i++)for(let c=0;c<outs.length;c++){
        const dest=outs[c]!,at=start+written+i;
        if(at<dest.length)dest[at]=dest[at]!+pcm[i*2+Math.min(c,1)]!;
      }
      written+=take;
    };
    for(const src of group){
      const length=Math.round(src.duration*sampleRate),buffer=src.buffer;
      const gain=Math.max(0,Math.min(GAIN_LINEAR_MAX,src.gainLinear));
      const left=buffer.getChannelData(0),right=buffer.getChannelData(Math.min(1,buffer.numberOfChannels-1));
      for(let pos=0;pos<length;pos+=2048){
        const n=Math.min(2048,length-pos),pcm=new Float32Array(n*2);
        for(let i=0;i<n;i++){
          const t=(pos+i)/sampleRate,position=(src.offset+t)*buffer.sampleRate,at=Math.floor(position),fraction=position-at;
          const amp=gain*spliceGain(t,(length-1)/sampleRate,src.offset>.0001,src.offset+src.duration<buffer.duration-.0001);
          pcm[i*2]=((left[at]??0)*(1-fraction)+(left[at+1]??left[at]??0)*fraction)*amp;
          pcm[i*2+1]=((right[at]??0)*(1-fraction)+(right[at+1]??right[at]??0)*fraction)*amp;
        }
        sourceRate.inputBuffer.putSamples(pcm);drain();
        if(++batches%64===0)await new Promise<void>(resolve=>setTimeout(resolve,0));
      }
    }
    // Flush the final processing window so the last syllable is not discarded.
    // Output is cropped to the exact scheduled duration, never the padded input.
    const silence=new Float32Array(4096);
    while(written<count){sourceRate.inputBuffer.putSamples(silence);drain();}
  }
}
