interface Token {id:string;text:string;clipId?:string;start?:number;end?:number;breakAfter?:boolean}
interface Span {startWordId:string;endWordId:string;reason:string}
/** Conservative exact-retake backstop: two adjacent substantial phrases with
 * an utterance boundary between them, not repeated short emphasis words. */
export function adjacentRetakes(words:Token[]):Span[] {
  const chars:{char:string;owner:number}[]=[];
  words.forEach((w,owner)=>{for(const char of w.text.normalize('NFKC').toLowerCase())if(/[\p{L}\p{N}]/u.test(char))chars.push({char,owner});});
  const spans:Span[]=[];
  for(let i=0;i<chars.length;i++) {
    for(let length=Math.min(80,Math.floor((chars.length-i)/2));length>=6;length--) {
      const first=chars[i]!.owner, last=chars[i+length-1]!.owner;
      const next=chars[i+length]!.owner, end=chars[i+2*length-1]!.owner;
      if(last===next || last-first<2 || words[first]!.clipId!==words[end]!.clipId)continue;
      if(i>0 && chars[i-1]!.owner===first)continue;
      if(i+2*length<chars.length && chars[i+2*length]!.owner===end)continue;
      const gap=words.slice(last,next).map(w=>w.text).join('');
      const boundary=/[，。！？；,.!?;]/u.test(gap)||words[last]!.breakAfter||((words[next]!.start??0)-(words[last]!.end??0)>.45);
      if(!boundary)continue;
      const phrase=chars.slice(i,i+length).map(c=>c.char).join('');
      if(new Set(phrase).size<4)continue;
      if(chars.slice(i+length,i+2*length).map(c=>c.char).join('')!==phrase)continue;
      spans.push({startWordId:words[first]!.id,endWordId:words[last]!.id,reason:'相邻两次重说同一短句，前一次停下后从头重来，建议保留后一次'});
      i+=length-1;break;
    }
  }
  return spans;
}
