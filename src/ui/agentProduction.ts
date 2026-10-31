import { productionDefaults,productionOptions,type ProductionOptions,type AgentMaterial } from '../edit/agentProduction';
export interface ProductionHooks {
 productionDefaults:()=>{speechRate:number;hasMusic:boolean;hasHighlights:boolean};
 materials:()=>Promise<Array<{id:string;name:string;duration:number}>>;
 material:(id:string)=>Promise<{blob:Blob;name:string;duration:number}|null>;
 duration:(blob:Blob)=>Promise<number>;
 previewQuote:(clipId:string,startWordId:string,endWordId:string)=>void;
}
type Api=(route:string,body?:unknown,raw?:File,retry?:boolean,headers?:Record<string,string>)=>Promise<any>;
export function mountAgentProduction(dialog:HTMLDialogElement,api:Api,hooks:ProductionHooks){
 const panel=document.createElement('section');panel.className='agent-production';
 panel.innerHTML=`<details class="agent-ai"><summary>AI API <span id="agent-ai-status">正在连接本机配置…</span></summary><div class="agent-grid">
 <label>API Base URL<input id="agent-ai-base" type="url" placeholder="https://api.deepseek.com" autocomplete="off" /></label><label>模型名称<input id="agent-ai-model" placeholder="供应商提供的模型 ID" autocomplete="off" /></label>
 <label class="agent-wide">API Key<input id="agent-ai-key" type="password" placeholder="已绑定时留空可保留原 Key" autocomplete="new-password" /></label></div>
 <p class="agent-muted">支持兼容 Chat Completions 的 API。文字稿和参考稿发往你绑定的服务；音频、配乐和 Key 保存在本机。现有转写服务仍负责音频转写。</p><div class="agent-inline"><button type="button" class="btn btn-sm" id="agent-ai-test">测试连接</button><button type="button" class="btn btn-sm" id="agent-ai-save">保存绑定</button><span id="agent-ai-message" role="status"></span></div></details>
 <div class="agent-section-heading"><h3>本期怎么剪</h3><span class="agent-muted">先清理内容，再安排片头和配乐</span></div>
 <div class="agent-grid"><label>片头精句<select id="agent-highlights"><option value="none">不添加精句</option><option value="choose">生成候选，由我选择</option><option value="auto">授权 Agent 自动选择</option></select></label><label>期望精句数<input id="agent-highlight-count" type="number" min="1" max="5" step="1" value="3" /></label>
 <label>配乐安排<select id="agent-music-mode"><option value="keep">保留工程已有配乐</option><option value="configure">按下面的素材重新安排</option></select></label><label>人声倍速<input id="agent-speech-rate" type="number" min="0.5" max="2" step="0.01" value="1" /></label></div>
 <p class="agent-muted" id="agent-existing-info"></p>
 <div id="agent-music-options"><div class="agent-materials">${(['opening','transition','ending'] as const).map((id,i)=>`<div class="agent-material"><label for="agent-${id}">${['开头背景音乐','话题过场音频','片尾音频'][i]}</label><div class="agent-inline"><select id="agent-${id}"><option value="">不添加</option></select><button type="button" class="btn btn-sm" id="agent-${id}-upload">上传音频</button><input id="agent-${id}-file" type="file" accept="audio/*,.wav,.mp3,.m4a" hidden /></div><span id="agent-${id}-status" class="agent-muted" role="status"></span></div>`).join('')}</div>
 <div class="agent-grid"><label>背景结束位置<select id="agent-opening-scope"><option value="highlights">跟随片头精句结束</option><option value="duration">按指定时长</option></select></label><label>指定背景时长（秒）<input id="agent-opening-duration" type="number" min="1" max="600" value="30" /></label>
 <label>音乐先行（秒）<input id="agent-opening-lead" type="number" min="0" max="30" step="0.1" value="3" /></label><label>背景音量（dB）<input id="agent-bed-gain" type="number" min="-40" max="0" step="1" value="-18" /></label>
 <label>过场音量（dB）<input id="agent-transition-gain" type="number" min="-40" max="6" step="1" value="-12" /></label><label>片尾音量（dB）<input id="agent-ending-gain" type="number" min="-40" max="6" step="1" value="-12" /></label></div>
 <p class="agent-muted">三个素材都可不添加。没有精句时，背景按指定时长播放；素材不足时以素材长度为准。过场放在话题切换处，片尾紧接最后一个字。音乐始终原速。</p></div>
 <details class="agent-skill"><summary id="agent-skill-name">初剪规范 · 加载中</summary><pre id="agent-skill-rules"></pre></details>
 <section id="agent-highlight-choices" hidden><h3>选择片头精句</h3><p class="agent-muted">按你勾选的先后顺序拼接，最多 5 条。可以试听原话；正文仍保留。取消勾选后重选可调整顺序。</p><div id="agent-highlight-list"></div><p id="agent-choice-order" role="status"></p><button class="btn btn-primary" type="button" id="agent-confirm-highlights">确认精句并完成初剪</button><button class="btn" type="button" id="agent-skip-highlights">本期不加精句</button></section>`;
 dialog.querySelector('.agent-progress')!.before(panel);
 const $=(id:string)=>panel.querySelector<HTMLElement>('#agent-'+id)!;
 const input=(id:string)=>$(id) as HTMLInputElement;
 const select=(id:string)=>$(id) as HTMLSelectElement;
 const key='podcut.agentProduction:'+(new URLSearchParams(location.search).get('project')||'default');
 let disabled=false,uploading=0,settingsBusy=false,choicesJob='',selectedIds:string[]=[];
 let savedAi={baseUrl:'',model:''};
 const uploaded:Partial<Record<'opening'|'transition'|'ending',AgentMaterial>>={};
 const fieldMap={highlights:'highlights',highlightCount:'highlight-count',musicMode:'music-mode',speechRate:'speech-rate',openingScope:'opening-scope',openingDurationSec:'opening-duration',openingLeadSec:'opening-lead',bedGainDb:'bed-gain',transitionGainDb:'transition-gain',endingGainDb:'ending-gain'} as const;
 const read=():ProductionOptions=>{
  const raw:any={...productionDefaults};for(const [name,id] of Object.entries(fieldMap)){const el=input(id);raw[name]=el.type==='number'?el.valueAsNumber:el.value;}
  for(const role of ['opening','transition','ending'] as const)if(select(role).value==='uploaded')raw[role]=uploaded[role];
  return productionOptions(raw);
 };
 const persist=()=>{try{localStorage.setItem(key,JSON.stringify({options:read(),library:Object.fromEntries(['opening','transition','ending'].map(r=>[r,select(r).value]))}));}catch{}};
 function sync(){
  for(const el of panel.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button'))el.disabled=disabled||uploading>0||settingsBusy;
  $('music-options').hidden=select('music-mode').value==='keep';input('highlight-count').disabled=disabled||select('highlights').value==='none';
  input('opening-duration').disabled=disabled||(select('opening-scope').value==='highlights'&&select('highlights').value!=='none');
 }
 panel.addEventListener('change',()=>{persist();sync();});
 async function populate(){
  const d=hooks.productionDefaults();let options={...productionDefaults,speechRate:d.speechRate,musicMode:d.hasMusic?'keep':'configure',highlights:d.hasHighlights?'none':'choose'} as ProductionOptions;let library:any={};
  try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved){options=productionOptions(saved.options);library=saved.library??{};}}catch{}
  for(const [name,id] of Object.entries(fieldMap))input(id).value=String(options[name as keyof ProductionOptions]);
  $('existing-info').textContent=d.hasHighlights?'当前工程已有片头精句；再次初剪请选择“不添加精句”。':'初剪保留稿外有效表达，不自动压缩故事、观点或正常强调。';
  const entries=await hooks.materials();
  for(const role of ['opening','transition','ending'] as const){
   const menu=select(role);menu.replaceChildren(new Option('不添加',''));
   for(const item of entries)menu.add(new Option(`${item.name} · ${item.duration.toFixed(1)}s`,item.id));
   if(options[role]){uploaded[role]=options[role];menu.add(new Option(options[role]!.name+' · 已上传','uploaded'));menu.value='uploaded';}else if(library[role])menu.value=library[role];
  }sync();
 }
 const aiFields=()=>({baseUrl:input('ai-base').value,model:input('ai-model').value,apiKey:input('ai-key').value});
 const showAi=(value:any)=>{savedAi={baseUrl:value.baseUrl,model:value.model};input('ai-base').value=value.baseUrl;input('ai-model').value=value.model;$('ai-status').textContent=value.configured?`已连接配置 · ${value.model}`:'未绑定';if(!value.configured)(panel.querySelector('.agent-ai') as HTMLDetailsElement).open=true;};
 for(const action of ['test','save'])$('ai-'+action).addEventListener('click',async()=>{
  settingsBusy=true;sync();$('ai-message').textContent=action==='test'?'正在测试…':'正在保存…';
  try{const value=await api('ai-'+action,aiFields());if(action==='save'){input('ai-key').value='';showAi(value);}$('ai-message').textContent=action==='test'?'✓ 连接及 JSON 输出正常':'✓ 已绑定，后续初剪和发布资料使用此 API';}catch(e){$('ai-message').textContent=e instanceof Error?e.message:String(e);}finally{settingsBusy=false;sync();}
 });
 async function upload(file:File,duration?:number){
  if(file.size>128*1024**2)throw Error('配乐最多 128 MB');
  const seconds=duration??await hooks.duration(file);
  if(!Number.isFinite(seconds)||seconds<=0||seconds>600)throw Error('配乐需为 10 分钟以内的音频');
  return await api('material',undefined,file,true,{'X-Audio-Duration':String(seconds),'Content-Type':file.type.startsWith('audio/')?file.type:'audio/wav'}) as AgentMaterial;
 }
 for(const role of ['opening','transition','ending'] as const){
  $(''+role+'-upload').addEventListener('click',()=>{input(role+'-file').value='';input(role+'-file').click();});
  input(role+'-file').addEventListener('change',async()=>{
   const file=input(role+'-file').files?.[0];if(!file)return;uploading++;sync();$(role+'-status').textContent='读取并保存音频…';
   try{uploaded[role]=await upload(file);let option=select(role).querySelector<HTMLOptionElement>('option[value="uploaded"]');if(!option){option=new Option('','uploaded');select(role).add(option);}option.text=uploaded[role]!.name+' · 已上传';select(role).value='uploaded';$(role+'-status').textContent=`✓ ${uploaded[role]!.duration.toFixed(1)} 秒 · 本机保存`;persist();}catch(e){$(role+'-status').textContent=String(e);}finally{uploading--;sync();}
  });
 }
 const selectedLabel=()=>{$('choice-order').textContent=selectedIds.length?'片头顺序：'+selectedIds.map((id,i)=>`${i+1}. ${id}`).join(' → '):'尚未选择精句';};
 let confirm:(ids:string[])=>Promise<void>=async()=>{};
 $('skip-highlights').addEventListener('click',()=>void confirm([]).catch(e=>{$('choice-order').textContent=String(e);}));
 $('confirm-highlights').addEventListener('click',async()=>{if(!selectedIds.length){$('choice-order').textContent='请先选择至少一条精句';return;}const b=$('confirm-highlights') as HTMLButtonElement;b.disabled=true;try{await confirm(selectedIds);}catch(e){$('choice-order').textContent=String(e);}finally{b.disabled=false;}});
 return {
  async init(){await populate();const [ai,skill]=await Promise.all([api('ai'),api('skill')]);showAi(ai);$('skill-name').textContent=`已加载初剪规范 · ${skill.version}`;$('skill-rules').textContent=skill.rules;},
  busy:()=>uploading>0||settingsBusy,
  disabled(value:boolean){disabled=value;sync();},
  async options(){
   if(uploading||settingsBusy)throw Error('请等素材或 API 配置保存完成');
   if(input('ai-key').value.trim()||input('ai-base').value!==savedAi.baseUrl||input('ai-model').value!==savedAi.model)throw Error('请先保存 AI 绑定，再开始初剪');
   const options=read();if(options.musicMode==='configure')for(const role of ['opening','transition','ending'] as const){const id=select(role).value;if(id&&id!=='uploaded'){const m=await hooks.material(id);if(!m)throw Error('素材已不存在，请重新选择');options[role]=await upload(new File([m.blob],m.name,{type:m.blob.type||'audio/wav'}),m.duration);}}
   persist();return options;
  },
  showChoices(job:any,onConfirm:(ids:string[])=>Promise<void>){
   confirm=onConfirm;const waiting=job?.status==='awaiting_selection';$('highlight-choices').hidden=!waiting;if(!waiting||choicesJob===job.id)return;
   choicesJob=job.id;selectedIds=[];$('highlight-list').replaceChildren();
   for(const h of job.highlights??[]){const row=document.createElement('article');row.className='agent-quote';const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.value=h.id;label.append(check,document.createTextNode(`${h.id} · ${h.title} · ${h.duration.toFixed(1)} 秒`));const quote=document.createElement('p'),why=document.createElement('p');quote.textContent=h.quote;why.className='agent-muted';why.textContent=h.reason;const listen=document.createElement('button');listen.type='button';listen.className='btn btn-sm';listen.textContent='试听原话';listen.addEventListener('click',()=>{const seg=h.segments[0],last=h.segments.at(-1);hooks.previewQuote(seg.clipId,seg.startWordId,last.endWordId);});check.addEventListener('change',()=>{if(check.checked){if(selectedIds.length>=5){check.checked=false;return;}selectedIds.push(h.id);}else selectedIds=selectedIds.filter(id=>id!==h.id);selectedLabel();});row.append(label,quote,why,listen);$('highlight-list').append(row);}selectedLabel();
  }
 };
}
