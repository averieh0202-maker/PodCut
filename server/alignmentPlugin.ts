import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Plugin } from 'vite';

/** One local model worker, shared across sequential chunks and released when idle. */
export function localAlignmentPlugin(): Plugin {
  let child: ChildProcessWithoutNullStreams | undefined;
  let pending: { resolve: (value: unknown) => void; reject: (e: Error) => void } | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  const stop = () => { clearTimeout(idle); const old = child; child = undefined; old?.kill(); };
  const install = (server: any) => {
    const root = server.config.root;
    const python = path.join(root, '.alignment-venv/bin/python');
    const ready = () => existsSync(python) && existsSync(path.join(root, '.alignment-model/model.safetensors')) && existsSync(path.join(root, '.alignment-model/fa-zh/model.pt'));
    const run = (request: unknown) => new Promise<unknown>((resolve, reject) => {
      clearTimeout(idle);
      if (!child) {
        const worker = spawn(python, ['-u', path.join(root, 'scripts/alignment_worker.py')], {
          cwd: root, env: { ...process.env, HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false', PYTORCH_ENABLE_MPS_FALLBACK: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child = worker;
        worker.stdin.on('error', () => { if (child === worker) { pending?.reject(new Error('本机对齐进程连接中断')); pending = undefined; stop(); } });
        let diagnostic = '';
        worker.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-2000); });
        createInterface({ input: worker.stdout }).on('line', line => {
          if (child !== worker || !pending) return;
          try { pending.resolve(JSON.parse(line)); } catch { pending.reject(new Error('本机对齐返回了无效数据')); }
          pending = undefined;
        });
        worker.on('error', () => { if (child === worker) { pending?.reject(new Error('无法启动本机对齐环境')); pending = undefined; child = undefined; } });
        worker.on('exit', () => {
          if (child !== worker) return;
          if (pending) console.error('[alignment] worker failed:', diagnostic);
          pending?.reject(new Error('本机对齐模型退出，请重试')); pending = undefined; child = undefined;
        });
      }
      pending = { resolve, reject };
      child.stdin.write(JSON.stringify(request) + '\n');
    });
    server.httpServer?.once('close', () => { pending?.reject(new Error('服务已关闭')); pending = undefined; stop(); });
    server.middlewares.use(async (req: any, res: any, next: () => void) => {
      if (req.url?.split('?')[0] !== '/api/alignment') return next();
      const json = (status: number, body: unknown) => { if (res.destroyed) return; res.statusCode = status; res.setHeader('Content-Type','application/json'); res.setHeader('Cache-Control','no-store'); res.end(JSON.stringify(body)); };
      const host = req.headers.host || '';
      let hostname = '';
      try { hostname = new URL(`http://${host}`).hostname; } catch { return json(400,{error:'Invalid host'}); }
      if (!['localhost','127.0.0.1','[::1]'].includes(hostname) || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return json(403,{error:'Local access only'});
      if ((req.headers.origin && ![`http://${host}`,`https://${host}`].includes(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') return json(403,{error:'Origin mismatch'});
      if (req.method === 'GET') return json(200,{ready:ready(),model:'Qwen3-ForcedAligner-0.6B',local:true});
      if (req.method !== 'POST') return json(405,{error:'POST required'});
      if (req.headers['content-type'] !== 'application/json' || req.headers['x-local-alignment'] !== '1') return json(400,{error:'Invalid alignment request'});
      if (!ready()) return json(503,{error:'本机对齐模型尚未安装，请运行 npm run setup:alignment'});
      if (busy) return json(429,{error:'本机正在对齐其他片段，请稍后重试'});
      busy = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => { if (!res.writableEnded && pending) { const p = pending; pending = undefined; stop(); p.reject(new Error('对齐已取消')); } };
      res.once('close', cancel);
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('对齐片段过大'); chunks.push(chunk); }
        if (res.destroyed) return;
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof body.audio !== 'string' || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000) return json(400,{error:'无效音频或文字'});
        timer = setTimeout(() => { const p = pending; pending = undefined; stop(); p?.reject(new Error('本机对齐超时，请缩短片段重试')); }, 180_000);
        const result: any = await run({audio:body.audio,text:body.text});
        json(result.error ? 422 : 200, result);
      } catch (e) { json(500,{error:e instanceof Error ? e.message : '对齐失败'}); }
      finally { clearTimeout(timer); res.off('close',cancel); busy = false; idle = setTimeout(stop, 300_000); idle.unref(); }
    });
  };
  return {name:'local-forced-alignment',configureServer:install,configurePreviewServer:install};
}
