import { SpeechPitchCorrector } from './continuousResampler';
import { tempoLatency } from './tempoQuality';
// AudioWorklet globals are not included in TypeScript's Window declarations.
declare const sampleRate:number;
declare const currentFrame:number;
declare class AudioWorkletProcessor { readonly port:MessagePort; }
declare function registerProcessor(name:string,ctor:typeof AudioWorkletProcessor):void;
/** Pitch compensation for rate-adjusted BufferSources, with a fixed output
 * reserve. The upstream worklet drains partial WSOLA windows immediately and
 * zero-fills missing frames, causing clicks even after its startup silence. */
class SpeechProcessor extends AudioWorkletProcessor {
  private pipe:SpeechPitchCorrector|null=null;
  private effectivePitch=0;
  private input=new Float32Array(256);
  private output=new Float32Array(256);
  private received=0;
  private startup=Math.round(tempoLatency(sampleRate)*sampleRate);
  private blocks=0;
  private startBlock=-1;
  private underruns=0;
  private readonly offlineQuality:boolean;
  constructor(options?:{processorOptions?:{offlineQuality?:boolean}}){
    super();this.offlineQuality=options?.processorOptions?.offlineQuality===true;
  }
  static get parameterDescriptors(){return [
    {name:'startBlock',defaultValue:0,minValue:0,maxValue:1e9,automationRate:'k-rate'},
    {name:'pitch',defaultValue:1,minValue:.1,maxValue:8,automationRate:'k-rate'},
    {name:'pitchSemitones',defaultValue:0,minValue:-24,maxValue:24,automationRate:'k-rate'},
    {name:'playbackRate',defaultValue:1,minValue:.1,maxValue:8,automationRate:'k-rate'},
  ];}
  process(inputs:Float32Array[][],outputs:Float32Array[][],params:Record<string,Float32Array>){
    const dest=outputs[0],left=dest?.[0];if(!left)return true;
    const startBlock=params.startBlock?.[0]??0;
    if(startBlock!==this.startBlock){this.startBlock=startBlock;this.pipe=null;this.received=0;this.blocks=0;this.underruns=0;}
    if(typeof currentFrame!=='undefined' && currentFrame/128<startBlock){for(const ch of dest)ch.fill(0);return true;}
    if(this.blocks===0 && typeof currentFrame!=='undefined')this.port.postMessage({type:'started',frame:currentFrame});
    const right=dest[1]??left,n=left.length;
    if(this.input.length!==n*2){this.input=new Float32Array(n*2);this.output=new Float32Array(n*2);}
    const src=inputs[0],l=src?.[0],r=src?.[1]??l;
    const rate=params.playbackRate[0]!;
    const pitch=params.pitch[0]!*Math.pow(2,params.pitchSemitones[0]!/12)/rate;
    if(!this.pipe||pitch!==this.effectivePitch){this.pipe=new SpeechPitchCorrector(sampleRate,pitch,this.offlineQuality);this.effectivePitch=pitch;this.received=0;}
    for(let i=0;i<n;i++){this.input[i*2]=l?.[i]??0;this.input[i*2+1]=r?.[i]??0;}
    this.pipe.inputBuffer.putSamples(this.input,0,n);this.pipe.process();
    const waiting=this.received<this.startup;this.received+=n;this.blocks++;
    left.fill(0);right.fill(0);
    const available=this.pipe.outputBuffer.frameCount;
    let peak=0,sum=0;
    if(!waiting){
      // Startup reserve is larger than a full processing window over 0.5–2×.
      // Do not drain a partial frame and introduce a discontinuity mid-block.
      if(available<n)this.underruns++;
      else {
        this.pipe.outputBuffer.extract(this.output,0,n);this.pipe.outputBuffer.receive(n);
        for(let i=0;i<n;i++){
          const a=Number.isFinite(this.output[i*2])?this.output[i*2]!:0,b=Number.isFinite(this.output[i*2+1])?this.output[i*2+1]!:0;
          left[i]=a;right[i]=b;peak=Math.max(peak,Math.abs(a),Math.abs(b));sum+=a*a+b*b;
        }
      }
    }
    if(this.blocks%100===0)this.port.postMessage({type:'metrics',framesBuffered:available,underrunCount:this.underruns,blockCount:this.blocks,outputRms:Math.sqrt(sum/(2*n)),outputPeak:peak});
    return true;
  }
}
registerProcessor('soundtouch-processor',SpeechProcessor);
