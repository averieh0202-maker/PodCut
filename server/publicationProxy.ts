import {execFileSync} from 'node:child_process';
import {Agent} from 'node:https';
import {request} from 'node:http';
import {connect} from 'node:tls';
let cached:{at:number;url:URL|null}|undefined;
function configuredProxy(){
 if(cached&&Date.now()-cached.at<60000)return cached.url;
 let raw=process.env.HTTPS_PROXY??process.env.https_proxy??'';
 if(!raw&&process.platform==='darwin')try{
  const settings=execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:2000});
  if(/HTTPSEnable\s*:\s*1\b/.test(settings)){const host=settings.match(/HTTPSProxy\s*:\s*([^\s]+)/)?.[1],port=settings.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];if(host&&port)raw=`http://${host}:${port}`;}
 }catch{}
 let url:URL|null=null;try{const p=new URL(raw);if(p.protocol==='http:')url=p;}catch{}
 cached={at:Date.now(),url};return url;
}
/** Respect the user's existing network proxy; do not change system settings.
 * HTTPS remains certificate-verified inside the CONNECT tunnel. */
export function publicationProxyAgent(target:URL):Agent|undefined {
 const proxy=configuredProxy();if(!proxy)return undefined;
 const agent=new Agent({keepAlive:false});
 agent.createConnection=((_options:any,callback:any)=>{
  const headers:Record<string,string>={Host:`${target.hostname}:443`};
  if(proxy.username||proxy.password)headers['Proxy-Authorization']='Basic '+Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64');
  const req=request({hostname:proxy.hostname,port:proxy.port||80,method:'CONNECT',path:`${target.hostname}:443`,headers});
  req.setTimeout(10000,()=>req.destroy(Error('公开来源代理连接超时')));
  req.on('connect',(res,socket,head)=>{
   if(res.statusCode!==200){socket.destroy();callback(Error('公开来源代理拒绝连接'));return;}
   if(head.length)socket.unshift(head);
   const secure=connect({socket,servername:target.hostname,rejectUnauthorized:true});
   const error=(e:Error)=>callback(e);secure.once('error',error);secure.once('secureConnect',()=>{secure.removeListener('error',error);callback(null,secure);});
  });req.on('error',callback);req.end();return undefined;
 }) as any;
 return agent;
}
