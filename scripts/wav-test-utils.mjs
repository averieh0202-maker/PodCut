/** Interleaved PCM sample expressed in 16-bit units for legacy assertions.
 * Read the declared data length (RIFF can contain a final alignment byte). */
export function pcm16(view,index){
 const bits=view.getUint16(34,true),at=44+index*(bits/8);
 if(bits===16)return view.getInt16(at,true);
 if(bits!==24)throw Error('Unexpected PCM depth '+bits);
 const value=view.getUint8(at)|(view.getUint8(at+1)<<8)|(view.getInt8(at+2)<<16);
 return value/256;
}
