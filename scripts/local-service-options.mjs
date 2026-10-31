import {readFile,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const applicationRoot=fileURLToPath(new URL('../',import.meta.url));
export async function serviceOptions(args=process.argv.slice(2),root=applicationRoot,env=process.env){
 root=await realpath(root);
 const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
 const at=args.indexOf('--port');
 const value=at>=0?args[at+1]:env.PODCUT_PORT??pkg.config?.podcutPort??5174;
 if(!/^\d+$/.test(String(value))||Number(value)<1024||Number(value)>65535)throw Error('PodCut 端口必须是 1024–65535 的整数');
 const port=Number(value);
 return {root,port,host:'127.0.0.1',url:`http://127.0.0.1:${port}`,label:`com.podcut.local.${port}`,runtime:path.join(root,'.podcast-drafts','service')};
}
export function launchAgentXml(options,node,script,logs,pathValue){
 const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
 const string=s=>`<string>${escape(s)}</string>`;
 return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key>${string(options.label)}
<key>ProgramArguments</key><array>${[node,script,'--port',String(options.port)].map(string).join('')}</array>
<key>WorkingDirectory</key>${string(options.root)}
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>15</integer>
<key>ProcessType</key><string>Background</string>
<key>EnvironmentVariables</key><dict><key>PATH</key>${string(pathValue)}</dict>
<key>StandardOutPath</key>${string(logs.stdout)}<key>StandardErrorPath</key>${string(logs.stderr)}
</dict></plist>\n`;
}
