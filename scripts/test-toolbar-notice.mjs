import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=await mkdtemp(join(tmpdir(),'podcut-notice-'));
try {
 const out=join(dir,'notice.mjs');
 await build({entryPoints:[resolve('src/ui/toolbarNotice.ts')],outfile:out,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
 let now=0,seq=0;const timers=new Map();
 globalThis.window={setTimeout(fn,ms){timers.set(++seq,{fn,at:now+ms});return seq;},clearTimeout(id){timers.delete(id);}};
 const advance=ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}};
 const element=()=>({hidden:true,children:[],events:{},addEventListener(name,fn){this.events[name]=fn;},replaceChildren(...children){this.children=children;},append(child){this.children.push(child);},contains(target){return this.children.includes(target);}});
 globalThis.document={activeElement:null,createElement:()=>element()};
 const {ToolbarNotice}=await import(pathToFileURL(out));const host=element(),notice=new ToolbarNotice(host);
 notice.show('completed',{link:{href:'/saved.wav',label:'下载 WAV',download:'episode.wav'}});
 assert.equal(host.hidden,false);assert.equal(host.children[1].href,'/saved.wav');assert.equal(host.children[1].download,'episode.wav');
 advance(4999);assert.equal(host.hidden,false);advance(1);assert.equal(host.hidden,true);
 notice.show('old');advance(4000);notice.show('new');advance(1000);assert.equal(host.hidden,false,'old timer cannot hide a later message');advance(4000);assert.equal(host.hidden,true);
 notice.show('processing',{duration:0});advance(60000);assert.equal(host.hidden,false,'running progress stays visible');
 notice.show('download');host.events.mouseenter();advance(6000);assert.equal(host.hidden,false);host.events.mouseleave();advance(5000);assert.equal(host.hidden,true);
 notice.show('download',{link:{href:'/file.wav',label:'download'}});document.activeElement=host.children[1];host.events.focusin();advance(6000);assert.equal(host.hidden,false,'focused download remains accessible');document.activeElement=null;host.events.focusout();advance(5000);assert.equal(host.hidden,true);
 console.log('✓ notice expiry, replacement, persistent progress, download links, hover and focus');
} finally {await rm(dir,{recursive:true,force:true});}
