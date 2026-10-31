/** A boundary touching a word's start/end selects no characters in that word. */
export function selectedWordElements(root: HTMLElement, selection: Selection | null): HTMLElement[] {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
  const words=Array.from(root.querySelectorAll<HTMLElement>('.word'));
  const selected=new Set<HTMLElement>();
  // DOM order is monotonic. Find the two boundary words with binary search
  // instead of asking Range.intersectsNode about every word on every pointer
  // event (especially costly in a transcript with thousands of siblings).
  const boundaries=new Map<number,{start:Range;end:Range}>();
  const at=(index:number)=>{
    let value=boundaries.get(index);if(value)return value;
    const word=words[index]!,walker=document.createTreeWalker(word,NodeFilter.SHOW_TEXT);
    const first=walker.nextNode();let last=first,next;
    while((next=walker.nextNode()))last=next;
    const start=document.createRange(),end=document.createRange();
    start.setStart(first??word,0);start.collapse(true);
    end.setStart(last??word,last?.textContent?.length??0);end.collapse(true);
    value={start,end};boundaries.set(index,value);return value;
  };
  for(let r=0;r<selection.rangeCount;r++){
    const range=selection.getRangeAt(r);
    if(!root.contains(range.startContainer)||!root.contains(range.endContainer))continue;
    const a=range.cloneRange(),b=range.cloneRange();a.collapse(true);b.collapse(false);
    let lo=0,hi=words.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(a.compareBoundaryPoints(Range.START_TO_START,at(mid).end)>=0)lo=mid+1;else hi=mid;}
    const first=lo;hi=words.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(b.compareBoundaryPoints(Range.START_TO_START,at(mid).start)>0)lo=mid+1;else hi=mid;}
    for(let i=first;i<lo;i++)if(words[i]!.textContent?.length)selected.add(words[i]!);
  }

  return selection.rangeCount>1 ? words.filter(w=>selected.has(w)) : [...selected];
}
/** Snap pointer drags to whole words in either direction, across lines/chips. */
export function selectWordSpan(root: HTMLElement, anchor: HTMLElement, focus: HTMLElement) {
  if(!root.contains(anchor)||!root.contains(focus))return;
  const forward=anchor===focus || !!(anchor.compareDocumentPosition(focus)&Node.DOCUMENT_POSITION_FOLLOWING);
  const range=document.createRange();range.setStartBefore(forward?anchor:focus);range.setEndAfter(forward?focus:anchor);
  root.focus({preventScroll:true});const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);
}
