import {mountPublicationExport} from './publicationClient';
import {episodeSegments} from './episodeTimeline';
async function main(){
 const id=new URLSearchParams(location.search).get('project')??'';(document.querySelector('#back') as HTMLAnchorElement).href='/?project='+encodeURIComponent(id);
 const session=await(await fetch('/api/draft/session')).json();const headers:Record<string,string>={'X-Draft-Token':session.token};if(id)headers['X-Project-Id']=id;
 const res=await fetch('/api/draft/current',{headers,cache:'no-store'});if(!res.ok)throw Error('本机工程读取失败');const p=(await res.json()).snapshot?.payload;if(!p?.clips?.length)throw Error('没有已保存的工程');
 const segments=episodeSegments(p.clips,p.music,p.speechRate??1);document.querySelector('#info')!.textContent=`已读取 ${segments.length} 段剪后文字。`;
 for(const button of document.querySelectorAll<HTMLButtonElement>('button'))button.disabled=false;
 mountPublicationExport(()=>segments,()=>p.audioName??'podcast');
}
void main().catch(e=>document.querySelector('#info')!.textContent=String(e));
