const params = new URLSearchParams(location.search);
const page=params.has('project')||params.get('editor')==='legacy'?import('./main'):import('./ui/projectHome');
void page.catch(()=>{
  const main=document.createElement('main');
  main.style.cssText='max-width:480px;margin:15vh auto;padding:28px;font:16px/1.7 system-ui,sans-serif;color:#242a27;background:#f6f7f6;border-radius:16px';
  const title=document.createElement('h1');title.textContent='页面资源加载失败';title.style.fontSize='22px';
  const message=document.createElement('p');message.textContent='工程文件仍保存在本机。服务恢复后，请重新加载页面继续剪辑。';
  const retry=document.createElement('button');retry.type='button';retry.textContent='重新加载';retry.style.cssText='border:0;border-radius:8px;padding:10px 18px;background:#196c54;color:white;font:inherit;cursor:pointer';retry.addEventListener('click',()=>location.reload());
  main.append(title,message,retry);document.body.replaceChildren(main);
});
