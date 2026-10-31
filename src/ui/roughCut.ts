import { mountAgentProduction,type ProductionHooks } from './agentProduction';
interface Seam {clipId:string;start:number;end:number;label:string;reason:string}
interface Job {id:string;status:string;stage:string;error?:string;removedSeconds:number;textCuts:number;seams:Seam[];referenceName?:string;reference?:string;threshold?:number;breaths?:boolean}
interface Hooks extends ProductionHooks {
 ready:()=>boolean;
 defaults:()=>{threshold:number;breaths:boolean};
 prepare:(options:{threshold:number;breaths:boolean})=>Promise<{revision:string;pauses:unknown[]}>;
 revision:()=>string|undefined|null;
 clean:()=>boolean;
 load:()=>Promise<void>;
 preview:(seam:Seam)=>void;
}
export function mountRoughCut(hooks:Hooks){
 const projectId=new URLSearchParams(location.search).get('project');
 const referenceKey='podcut.agentReference'+(projectId?':'+projectId:'');
 const autoKey='podcut.agentAutoOpen'+(projectId?':'+projectId:'');
 const trigger=document.querySelector<HTMLButtonElement>('#btn-agent-cut')!;
 const dialog=document.createElement('dialog');dialog.className='agent-dialog';dialog.setAttribute('aria-labelledby','agent-title');
 dialog.innerHTML=`<form method="dialog" class="agent-heading"><div><span class="agent-eyebrow">FIRST CUT</span><h2 id="agent-title">Agent 初剪</h2></div><button class="btn btn-icon" aria-label="关闭初剪面板">×</button></form>
 <p class="agent-intro">保留你的完整表达，先清理明确的重录、假开头和停顿。参考稿外的有效内容照常保留。</p>
 <div class="agent-reference-head"><label for="agent-reference">参考逐字稿 <span>可选</span></label><button type="button" class="btn btn-sm" id="agent-upload">上传参考稿</button><input id="agent-file" type="file" accept=".txt,.md,.srt,.vtt,.docx" hidden /></div>
 <textarea id="agent-reference" maxlength="50000" placeholder="粘贴录制前的稿件，或上传 TXT / Word / 字幕文件。也可以不提供，直接根据实际录音初剪。"></textarea>
 <p id="agent-file-name" class="agent-muted" role="status" aria-live="polite">支持 TXT、MD、SRT、VTT、DOCX</p>
 <div class="agent-options"><label>删除长于 <input id="agent-threshold" type="number" min="0.1" max="3" step="0.05" /> 秒的停顿</label><label><input type="checkbox" id="agent-breaths" checked /> 包含吸气</label><span class="agent-muted">按整处停顿总时长计算</span></div>
 <div class="agent-progress" aria-live="polite"><strong id="agent-stage">准备初剪</strong><p id="agent-detail">完成后自动打开初剪稿，可整次撤销。处理期间可以关闭页面，本机服务需保持运行。</p></div>
 <div id="agent-result" hidden><div class="agent-result-head"><strong id="agent-result-summary"></strong><span id="agent-seam-count"></span></div><p id="agent-seam-label"></p><p id="agent-seam-reason" class="agent-muted"></p><div class="agent-seam-controls"><button class="btn btn-sm" id="agent-prev">上一处</button><button class="btn btn-sm" id="agent-listen">试听接缝</button><button class="btn btn-sm" id="agent-next">下一处</button></div></div>
 <div class="agent-footer"><button class="btn" id="agent-cancel" hidden>取消任务</button><button class="btn" id="agent-undo" hidden>撤销整次初剪</button><button class="btn btn-primary" id="agent-open" hidden>打开初剪</button><button class="btn btn-primary" id="agent-start">开始初剪</button></div>`;
 document.body.appendChild(dialog);
 const $=<T extends HTMLElement>(id:string)=>dialog.querySelector<T>('#'+id)!;
 const reference=$<HTMLTextAreaElement>('agent-reference'),file=$<HTMLInputElement>('agent-file'),threshold=$<HTMLInputElement>('agent-threshold');
 let autoOpenId='';try{autoOpenId=localStorage.getItem(autoKey)??'';}catch{}
 const setAutoOpen=(id:string)=>{autoOpenId=id;try{if(id)localStorage.setItem(autoKey,id);else localStorage.removeItem(autoKey);}catch{}};
 let productionReady=false;
 let session:string|undefined,job:Job|null=null,poll:ReturnType<typeof setTimeout>|undefined,seamIndex=0,busy=false,referenceName='';
 async function api(route:string,body?:unknown,raw?:File,retry=true,extraHeaders:Record<string,string>={}):Promise<any>{
  if(!session){const res=await fetch('/api/rough-cut/session',{signal:AbortSignal.timeout(15000)});if(!res.ok)throw Error('初剪服务未连接，请确认本机预览已更新');session=(await res.json()).token;}
  const res=await fetch('/api/rough-cut/'+route,{signal:AbortSignal.timeout(route==='ai-test'||route==='material'?150000:30000),method:body!==undefined||raw?'POST':'GET',headers:{'X-Agent-Token':session!,...extraHeaders,...(projectId?{'X-Project-Id':projectId}:{}),...(raw?{'X-File-Name':encodeURIComponent(raw.name)}:body!==undefined?{'Content-Type':'application/json'}:{})},body:raw??(body!==undefined?JSON.stringify(body):undefined)});
  if(res.status===401){session=undefined;if(retry)return api(route,body,raw,false,extraHeaders);throw Error('本机连接未恢复，请稍后重试');}
  const value=await res.json();if(!res.ok)throw Error(value.error||'初剪操作失败');return value;
 }
 const production=mountAgentProduction(dialog,api,hooks);
 dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
 dialog.querySelector('.agent-heading')!.addEventListener('submit',event=>{if(busy)event.preventDefault();});
 const error=(e:unknown)=>{$('agent-stage').textContent='暂未完成';$('agent-detail').textContent=e instanceof Error?e.message:String(e);};
 const upload=$<HTMLButtonElement>('agent-upload');
 let referenceTouched=false;
 const referenceStatus=(message:string,failed=false)=>{const status=$('agent-file-name');status.textContent=message;status.style.color=failed?'#f0a58e':'';};
 const saveReference=()=>{try{localStorage.setItem(referenceKey,JSON.stringify({text:reference.value,name:referenceName}));}catch{referenceStatus('参考稿已读入，但浏览器存储不可用；请勿刷新页面',true);}};
 try{const saved=JSON.parse(localStorage.getItem(referenceKey)||'null');if(saved&&typeof saved.text==='string'&&saved.text.length<=50000){reference.value=saved.text;referenceName=typeof saved.name==='string'?saved.name:'';referenceTouched=true;if(saved.text)referenceStatus(`已恢复 · ${referenceName||'粘贴的参考稿'} · ${saved.text.length} 字`);}}catch{}
 reference.addEventListener('input',()=>{referenceTouched=true;referenceStatus(reference.value?`${referenceName||'粘贴的参考稿'} · ${reference.value.length} 字`:'支持 TXT、MD、SRT、VTT、DOCX');saveReference();});
 function syncControls(){const disabled=job?.status==='running'||busy;reference.disabled=file.disabled=threshold.disabled=upload.disabled=$<HTMLInputElement>('agent-breaths').disabled=disabled;$<HTMLButtonElement>('agent-start').disabled=disabled||!hooks.ready()||!productionReady||job?.status==='awaiting_selection';production.disabled(disabled);}
 upload.addEventListener('click',()=>{if(upload.disabled)return;file.value='';file.click();});
 function paint(){
  const running=job?.status==='running';trigger.textContent=running?'初剪中…':job?.status==='ready'?'初剪完成':'Agent 初剪';
  syncControls();
  $<HTMLButtonElement>('agent-start').disabled=!!running||busy||!hooks.ready()||!productionReady||job?.status==='awaiting_selection';
  $('agent-start').textContent=job?'重新初剪':'一键初剪';
  $('agent-cancel').hidden=!running;$('agent-open').hidden=!job||!['ready','undone'].includes(job.status);$('agent-open').textContent=job?.status==='undone'?'重新打开初剪':'打开初剪';$('agent-undo').hidden=job?.status!=='applied';
  $('agent-result').hidden=!job||!['ready','applied','undone'].includes(job.status);
  production.showChoices(job,async selectedIds=>{if(busy||!job)return;busy=true;syncControls();try{job=await api('select',{id:job.id,selectedIds});setAutoOpen(job!.id);paint();clearTimeout(poll);poll=setTimeout(refresh,500);}finally{busy=false;syncControls();}});
  if(job){$('agent-stage').textContent=job.stage;$('agent-detail').textContent=job.error||(running?'所选 AI 按已加载规范处理文字和参考稿，声音保留在本机。可以关闭面板，稍后回来查看。':job.status==='awaiting_selection'?'请选择下方完整精句，再确认组装。原稿尚未改变。':job.status==='ready'?'初剪草稿已保存。打开后可直接试听、逐处复原；不会覆盖初剪开始后的新修改。':job.status==='applied'?'已进入初剪稿，所有删除均可复原。整次撤销适用于尚未继续修改的初剪稿。':'原稿已保留，可调整参考稿后重试。');}
  if(job){$('agent-result-summary').textContent=`清理 ${job.textCuts} 处重录 / 假开头 · 缩短 ${job.removedSeconds.toFixed(1)} 秒`;const seam=job.seams[seamIndex];$('agent-seam-count').textContent=seam?`${seamIndex+1} / ${job.seams.length} 处接缝`:'没有需要删除的内容';$('agent-seam-label').textContent=seam?.label??'';$('agent-seam-reason').textContent=seam?.reason??'';$<HTMLButtonElement>('agent-listen').disabled=job.status!=='applied'||!seam;$<HTMLButtonElement>('agent-prev').disabled=!seam||seamIndex===0;$<HTMLButtonElement>('agent-next').disabled=!seam||seamIndex>=job.seams.length-1;}
 }
 async function refresh(){try{const first=!job;job=await api('latest');if(first&&job&&!referenceTouched&&reference.value===''){reference.value=job.reference??'';referenceName=job.referenceName??'';$('agent-file-name').textContent=referenceName||'已恢复本机初剪记录';threshold.value=String(job.threshold??hooks.defaults().threshold);}paint();if(job?.id===autoOpenId&&job.status==='ready'&&!busy&&hooks.ready()){setAutoOpen('');await switchDraft('apply',true);}if(job?.status==='running'||(job?.id===autoOpenId&&job.status==='ready'))poll=setTimeout(refresh,3000);}catch(e){if(dialog.open)error(e);}}
 trigger.addEventListener('click',()=>{if(!dialog.open)dialog.showModal();if(!productionReady){void production.init().then(()=>{productionReady=true;paint();}).catch(error);}if(!job){const d=hooks.defaults();threshold.value=String(d.threshold);}clearTimeout(poll);void refresh();paint();});
 file.addEventListener('change',async()=>{
  const selected=file.files?.[0];if(!selected)return;file.value='';
  if(busy||job?.status==='running')return;
  referenceTouched=true;
  if(selected.size>20*1024**2){referenceStatus('读取失败：参考稿文件最多 20 MB；可另存为不含图片的 Word 文档',true);return;}
  busy=true;paint();upload.textContent='读取中…';referenceStatus(`正在读取 ${selected.name}…`);
  try{
   const res=await api('reference',undefined,selected);
   if(typeof res.text!=='string'||!res.text.trim())throw Error('文档中没有可读取的正文，请上传包含文字的 DOCX，或直接粘贴逐字稿');
   reference.value=res.text;referenceName=selected.name;
   referenceStatus(`✓ 已读入 · ${referenceName} · ${reference.value.length} 字`);saveReference();
  }catch(e){referenceStatus(`读取失败：${e instanceof Error?e.message:String(e)}${reference.value?'（原参考稿已保留）':''}`,true);}
  finally{busy=false;upload.textContent='上传参考稿';syncControls();}
 });
 $('agent-start').addEventListener('click',async()=>{
  if(busy||production.busy()||job?.status==='running')return;busy=true;paint();$('agent-stage').textContent='保存原稿并检查停顿…';
  try{const arrangement=await production.options();const options={threshold:Number(threshold.value),breaths:$<HTMLInputElement>('agent-breaths').checked};if(!Number.isFinite(options.threshold)||options.threshold<.1||options.threshold>3)throw Error('停顿阈值应为 0.1–3 秒');const prepared=await hooks.prepare(options);job=await api('start',{id:crypto.randomUUID(),...prepared,...options,reference:reference.value,referenceName,production:arrangement});setAutoOpen(job!.id);seamIndex=0;paint();clearTimeout(poll);poll=setTimeout(refresh,1000);}catch(e){error(e);}finally{busy=false;syncControls();}
 });
 $('agent-cancel').addEventListener('click',async()=>{try{await api('cancel',{id:job!.id});clearTimeout(poll);poll=setTimeout(refresh,500);}catch(e){error(e);}});
 async function switchDraft(action:'apply'|'undo',automatic=false){
  if(busy||!job)return;busy=true;
  try{if(!hooks.clean())throw Error('当前仍有未保存修改，请先保存后再打开初剪');const revision=hooks.revision();if(!revision)throw Error('请先恢复本机草稿');job=await api(action,{id:job.id,revision});await hooks.load();paint();if(automatic)dialog.close();}catch(e){error(e);}finally{busy=false;syncControls();}
 }
 $('agent-open').addEventListener('click',()=>void switchDraft('apply'));
 $('agent-undo').addEventListener('click',()=>void switchDraft('undo'));
 $('agent-prev').addEventListener('click',()=>{seamIndex=Math.max(0,seamIndex-1);paint();});$('agent-next').addEventListener('click',()=>{seamIndex=Math.min(job!.seams.length-1,seamIndex+1);paint();});
 $('agent-listen').addEventListener('click',()=>{if(job?.status==='applied'&&job.seams[seamIndex]){hooks.preview(job.seams[seamIndex]!);dialog.close();}});
 const defaults=hooks.defaults();threshold.value=String(defaults.threshold);
 void refresh();
}
