import type {EpisodeSegment} from './episodeTimeline';
import {buildPublicationTranscript} from './publicationTranscript';
interface Publication {key:string;stage:string;percent:number;done?:boolean;error?:string;kind?:string;result?:{article:string;showNotes:string;chapterWarning?:string};}
export function mountPublicationExport(getSegments:()=>EpisodeSegment[]|null,getName:()=>string){
 const articleButton=document.getElementById('btn-export-article') as HTMLButtonElement|null;
 const notesButton=document.getElementById('btn-export-notes') as HTMLButtonElement|null;
 const project=new URLSearchParams(location.search).get('project');
 const panel=document.createElement('div');panel.setAttribute('role','status');panel.style.cssText='display:none;position:fixed;right:20px;top:100px;z-index:501;max-width:400px;padding:16px 20px;border:1px solid #50756a;border-radius:12px;background:#192725;color:#e3efed;box-shadow:0 6px 30px #0006';document.body.append(panel);
 let token='',timer=0,busy=false,urls:string[]=[],requested=false,inputKey='';
 async function request(route:string,body?:unknown,retry=true):Promise<Publication|null>{
  if(!token){const s=await fetch('/api/rough-cut/session',{signal:AbortSignal.timeout(15000)});if(!s.ok)throw Error('本机 AI 服务不可用');token=(await s.json()).token;}
  const headers:Record<string,string>={'X-Agent-Token':token,'Content-Type':'application/json'};if(project)headers['X-Project-Id']=project;
  const r=await fetch('/api/rough-cut/'+route,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(r.status===401&&retry){token='';return request(route,body,false);}const data=await r.json();if(!r.ok)throw Error(data.error??'生成服务异常');return data;
 }
 function download(text:string,label:string){
  const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=`${getName()}-${label}.md`;document.body.append(a);a.click();a.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),60000);
 }
 function closeButton(){const close=document.createElement('button');close.className='btn';close.textContent='收起';close.style.marginTop='12px';close.onclick=()=>panel.style.display='none';panel.append(close);}
 function show(s:Publication|null){
  clearTimeout(timer);if(!s||s.kind!=='showNotes')return;panel.style.display='block';panel.replaceChildren();for(const url of urls)URL.revokeObjectURL(url);urls=[];
  busy=!s.done&&!s.error;if(notesButton)notesButton.disabled=busy;
  const title=document.createElement('div');title.textContent=s.error?`生成失败：${s.error}`:`${s.stage}${s.done?'':` · ${s.percent}%`}`;panel.append(title);
  if(s.result){
   const changed=inputKey&&JSON.stringify(getSegments())!==inputKey;
   if(changed){const p=document.createElement('p');p.textContent='剪辑已变化；这些文件对应开始生成时的版本，可重新生成。';panel.append(p);}
   for(const [field,label] of [['article','播客长文稿'],['showNotes','简介与时间戳']] as const){if(!s.result[field])continue;const a=document.createElement('a'),url=URL.createObjectURL(new Blob([s.result[field]],{type:'text/markdown;charset=utf-8'}));urls.push(url);a.href=url;a.download=`${getName()}-${label}.md`;a.textContent=`下载${label}`;a.style.cssText='display:block;color:#9cebd4;margin-top:10px';panel.append(a);if(requested&&field==='showNotes'&&!changed)a.click();}
   requested=false;if(s.result.chapterWarning){const p=document.createElement('p');p.textContent=s.result.chapterWarning;panel.append(p);}
  }
  if(!busy)closeButton();else timer=window.setTimeout(()=>void poll(),1500);
 }
 async function poll(){try{show(await request('publish-progress'));}catch{panel.textContent='暂时无法读取进度，正在重新连接…';timer=window.setTimeout(()=>void poll(),4000);}}
 async function startNotes(){
  if(busy){panel.style.display='block';return;}const segments=getSegments();if(!segments?.length){panel.style.display='block';panel.textContent='没有可导出的剪后文字';closeButton();return;}
  busy=true;if(notesButton)notesButton.disabled=true;requested=true;inputKey=JSON.stringify(segments);panel.style.display='block';panel.textContent='正在创建简介与时间戳任务…';
  try{show(await request('publish-start',{segments,kind:'showNotes'}));}catch(e){show({key:'',kind:'showNotes',stage:'',percent:0,error:e instanceof Error?e.message:String(e)});}
 }
 articleButton?.addEventListener('click',()=>{
  try{download(buildPublicationTranscript(getSegments()??[]),'播客长文稿');}
  catch(e){panel.style.display='block';panel.textContent=e instanceof Error?e.message:String(e);closeButton();}
 });
 notesButton?.addEventListener('click',()=>void startNotes());
 if(['localhost','127.0.0.1','[::1]'].includes(location.hostname))void request('publish-progress').then(show).catch(()=>{});
}
