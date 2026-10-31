import type {Plugin} from 'vite';
export function healthPlugin():Plugin{
 const install=(server:any,mode:string)=>{
  const startedAt=Date.now();
  server.middlewares.use((req:any,res:any,next:()=>void)=>{
   if(req.url?.split('?')[0]!=='/api/health')return next();
   const host=req.headers.host??'';let hostname='';try{hostname=new URL('http://'+host).hostname;}catch{}
   if(!['127.0.0.1','localhost','[::1]'].includes(hostname)||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){res.statusCode=403;res.end('Local access only');return;}
   res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
   if(req.method!=='GET'){res.statusCode=405;res.end(JSON.stringify({error:'GET required'}));return;}
   res.end(JSON.stringify({app:'PodCut',status:'ok',mode,startedAt,pid:process.pid}));
  });
 };
 return {name:'podcut-health',configureServer:s=>install(s,'development'),configurePreviewServer:s=>install(s,'production')};
}
