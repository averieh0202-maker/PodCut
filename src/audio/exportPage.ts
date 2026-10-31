import {latestLocalExport,localExportStatus,startLocalExport,type ExportJob} from './localExport';
const id=new URLSearchParams(location.search).get('project')??'';
const state=document.querySelector<HTMLElement>('#state')!,button=document.querySelector<HTMLButtonElement>('#start')!,progress=document.querySelector<HTMLProgressElement>('#progress')!,link=document.querySelector<HTMLAnchorElement>('#download')!;
(document.querySelector('#back') as HTMLAnchorElement).href='/?project='+encodeURIComponent(id);
let timer=0;
function show(job:ExportJob|null){
 clearTimeout(timer);button.disabled=false;
 if(!job){state.textContent='暂无导出任务。';return;}
 progress.value=job.percent;
 if(job.error){state.textContent='导出失败：'+job.error;return;}
 if(job.done){state.textContent='音频已生成，可以下载';link.href=job.download!;link.download='podcast-edited.wav';link.textContent=`下载 WAV · ${((job.bytes??0)/1024/1024).toFixed(1)} MB`;link.style.display='block';document.querySelector('#detail')!.textContent='文件已保存在本机，下载未开始时可再次点击。';return;}
 button.disabled=true;link.style.display='none';state.textContent=`${job.stage} · ${job.percent}%`;
 timer=window.setTimeout(async()=>{try{show(await localExportStatus(job.id));}catch{state.textContent='正在重新连接本机进度…';timer=window.setTimeout(()=>show(job),4000);}},1500);
}
button.onclick=async()=>{button.disabled=true;state.textContent='读取已保存的工程…';try{
 const session=await(await fetch('/api/draft/session')).json();const headers:Record<string,string>={'X-Draft-Token':session.token};if(id)headers['X-Project-Id']=id;
 const r=await fetch('/api/draft/current',{headers,cache:'no-store'});if(!r.ok)throw Error('无法读取本机工程');const snapshot=(await r.json()).snapshot;if(!snapshot)throw Error('没有已保存的本机工程');
 show(await startLocalExport(snapshot.revision));
}catch(e){state.textContent='无法导出：'+String(e);button.disabled=false;}};
void latestLocalExport().then(show).catch(e=>{state.textContent='无法连接本机导出服务：'+String(e);});
