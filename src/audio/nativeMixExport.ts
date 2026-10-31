import type { MixSchedule, MixSource } from './mixSchedule';
import { bakeFadedBufferSlice } from './mixSchedule';
import { speechTempoMap, tempoDuration } from './speechTempo';
import { tempoLatency, SPEECH_PREROLL_SEC } from './tempoQuality';
import { SPLICE_FADE_SEC } from './splice';

function sourceNode(ctx:OfflineAudioContext,src:MixSource,dest:AudioNode,rate:number,when:number){
  const speech=src.role==='speech',source=ctx.createBufferSource(),gain=ctx.createGain();
  gain.gain.value=src.gainLinear;source.connect(gain);gain.connect(dest);
  const fadeIn=speech?(src.offset>.0001?SPLICE_FADE_SEC:0):(src.fadeInSec??0);
  const fadeOut=speech?(src.offset+src.duration<src.buffer.duration-.0001?SPLICE_FADE_SEC:0):(src.fadeOutSec??0);
  source.buffer=fadeIn||fadeOut?bakeFadedBufferSlice(ctx,src.buffer,src.offset,src.duration,fadeIn,fadeOut,src.duration,0):src.buffer;
  source.playbackRate.value=rate;
  source.start(when,fadeIn||fadeOut?0:src.offset,fadeIn||fadeOut?source.buffer.duration:src.duration);
}

/** Use the same speech clock, sample rate and worklet preset as live playback.
 * Music bypasses the speech processor and retains its original speed/fades. */
export async function renderNativeMix(mix:MixSchedule,speed:number,sampleRate:number,channels:number,offlineQuality=false){
  const tempo=speechTempoMap(mix,speed);
  const frames=Math.max(1,Math.ceil(tempoDuration(mix,speed)*sampleRate));
  const ctx=new OfflineAudioContext(channels,frames,sampleRate);
  if(speed===1){
    for(const src of mix.sources)if(src.duration>0)sourceNode(ctx,src,ctx.destination,1,tempo.toWall(src.whenEdit));
  }else{
    const [{SoundTouchNode},{default:processorUrl}]=await Promise.all([import('@soundtouchjs/audio-worklet'),import('./speechProcessor?worker&url')]);
    const voices=mix.sources.filter(s=>s.role==='speech');
    if(voices.length){
      const warmup=SPEECH_PREROLL_SEC,delay=warmup+tempoLatency(sampleRate);
      const voiceChannels=Math.min(2,Math.max(...voices.map(s=>s.buffer.numberOfChannels)));
      const voiceCtx=new OfflineAudioContext(voiceChannels,frames+Math.ceil(delay*sampleRate)+128,sampleRate);
      await SoundTouchNode.register(voiceCtx,processorUrl);
      const processor=new AudioWorkletNode(voiceCtx,'soundtouch-processor',{
        numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[voiceChannels],
        processorOptions:{offlineQuality},parameterData:{playbackRate:speed,startBlock:0},
      });processor.connect(voiceCtx.destination);
      const silence=voiceCtx.createConstantSource();silence.offset.value=0;silence.connect(processor);silence.start();
      for(const src of voices)if(src.duration>0)sourceNode(voiceCtx,src,processor,speed,warmup+tempo.toWall(src.whenEdit));
      const rendered=await voiceCtx.startRendering();processor.disconnect();processor.port.close();silence.disconnect();
      const node=ctx.createBufferSource();node.buffer=rendered;node.connect(ctx.destination);node.start(0,delay,frames/sampleRate);
    }
    for(const src of mix.sources)if(src.role!=='speech'&&src.duration>0)sourceNode(ctx,src,ctx.destination,1,tempo.toWall(src.whenEdit));
  }
  const buffer=await ctx.startRendering();
  return {buffer,offset:0,frames};
}
