import { CircularSampleBuffer, Stretch } from '@soundtouchjs/core';
import { SPEECH_STRETCH } from './tempoQuality';

const RADIUS=16, TAPS=RADIUS*2, PHASES=1024;
/** Windowed-sinc resampling with real history AND lookahead. Never clamp an
 * AudioWorklet block's edges to its final/previous sample: that injects a
 * periodic high-frequency error every 128 frames. Input chunks are transport
 * boundaries only, not acoustic boundaries. Stereo shares one sample clock. */
export class ContinuousResampler {
  readonly inputBuffer=new CircularSampleBuffer();
  readonly outputBuffer=new CircularSampleBuffer();
  private position=RADIUS;
  private kernels:Float32Array;
  private input=new Float32Array(0);
  private output=new Float32Array(0);
  constructor(readonly rate:number){
    if(!Number.isFinite(rate)||rate<=0)throw Error('Invalid resampling rate');
    // Negative-time history is silence only at the true start of the stream.
    this.inputBuffer.putSamples(new Float32Array(RADIUS*2));
    this.kernels=new Float32Array((PHASES+1)*TAPS);
    const cutoff=Math.min(1,1/rate)*.94;
    for(let phase=0;phase<=PHASES;phase++){
      const fraction=phase/PHASES;let sum=0;
      for(let tap=0;tap<TAPS;tap++){
        const distance=tap-(RADIUS-1)-fraction,x=Math.PI*distance*cutoff;
        const window=.42+.5*Math.cos(Math.PI*distance/RADIUS)+.08*Math.cos(2*Math.PI*distance/RADIUS);
        const value=(Math.abs(x)<1e-12?1:Math.sin(x)/x)*cutoff*window;
        this.kernels[phase*TAPS+tap]=value;sum+=value;
      }
      for(let tap=0;tap<TAPS;tap++)this.kernels[phase*TAPS+tap]/=sum;
    }
  }
  process(){
    const count=this.inputBuffer.frameCount;
    if(Math.floor(this.position)+RADIUS>=count)return;
    if(this.input.length<count*2)this.input=new Float32Array(count*2);
    this.inputBuffer.extract(this.input,0,count);
    const capacity=(Math.ceil(count/this.rate)+2)*2;
    if(this.output.length<capacity)this.output=new Float32Array(capacity);
    let frames=0;
    while(Math.floor(this.position)+RADIUS<count){
      const center=Math.floor(this.position),phase=(this.position-center)*PHASES;
      const index=Math.floor(phase),blend=phase-index,base=index*TAPS;
      let left=0,right=0;
      for(let tap=0;tap<TAPS;tap++){
        const k=this.kernels[base+tap]*(1-blend)+this.kernels[base+TAPS+tap]*blend;
        const at=(center-RADIUS+1+tap)*2;
        left+=this.input[at]*k;right+=this.input[at+1]*k;
      }
      this.output[frames*2]=left;this.output[frames*2+1]=right;frames++;this.position+=this.rate;
    }
    this.outputBuffer.putSamples(this.output,0,frames);
    const consumed=Math.max(0,Math.floor(this.position)-RADIUS);
    this.inputBuffer.receive(consumed);this.position-=consumed;
  }
}

/** SoundTouch's WSOLA stage paired with a continuous resampler. Its built-in
 * RateTransposer retains only one historical sample and clamps future taps at
 * each process() boundary. Keep its speech matching, replace that resampler. */
export class SpeechPitchCorrector {
  readonly inputBuffer:CircularSampleBuffer;
  readonly outputBuffer:CircularSampleBuffer;
  private resampler:ContinuousResampler;
  private stretch:Stretch;
  private resampleFirst:boolean;
  private bridge=new Float32Array(0);
  constructor(sampleRate:number,pitch:number,offlineQuality=false){
    this.resampler=new ContinuousResampler(pitch);
    this.stretch=new Stretch({sampleRate,createBuffers:true});
    this.stretch.setStretchParameters({...SPEECH_STRETCH,quickSeek:!offlineQuality && SPEECH_STRETCH.quickSeek});this.stretch.tempo=1/pitch;
    this.resampleFirst=pitch<=1;
    this.inputBuffer=(this.resampleFirst?this.resampler.inputBuffer:this.stretch.inputBuffer) as CircularSampleBuffer;
    this.outputBuffer=(this.resampleFirst?this.stretch.outputBuffer:this.resampler.outputBuffer) as CircularSampleBuffer;
  }
  process(){
    const first=this.resampleFirst?this.resampler:this.stretch,second=this.resampleFirst?this.stretch:this.resampler;
    first.process();
    const n=first.outputBuffer!.frameCount;
    if(n){
      if(this.bridge.length<n*2)this.bridge=new Float32Array(n*2);
      first.outputBuffer!.extract(this.bridge,0,n);first.outputBuffer!.receive(n);
      second.inputBuffer!.putSamples(this.bridge,0,n);
    }
    second.process();
  }
}
