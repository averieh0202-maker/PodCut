export interface ExportJob {id:string;stage:string;percent:number;done?:boolean;error?:string;download?:string;bytes?:number;revision?:string;}
const project=new URLSearchParams(location.search).get('project')??'';
const query='?project='+encodeURIComponent(project);
async function request(path:string,init:RequestInit={}):Promise<ExportJob|null>{
 const res=await fetch('/api/export/'+path+query,{...init,cache:'no-store',signal:AbortSignal.timeout(15000)});
 if(!res.ok){const body=await res.json().catch(()=>({}));throw Error(body.error??`本机导出服务异常（${res.status}）`);}return res.json();
}
export const latestLocalExport=()=>request('latest');
export const localExportStatus=(id:string)=>request('status/'+encodeURIComponent(id));
export const startLocalExport=(revision:string)=>request('start',{method:'POST',headers:{'Content-Type':'application/json','X-Podcut-Export':'1'},body:JSON.stringify({revision})});
