import { projectRoot } from './projectScope';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { DiskDraftStore, DraftConflict } from './diskDraftStore';
import { ProjectCatalog } from './projectCatalog';

export function diskDraftPlugin(): Plugin {
  const token = randomBytes(32).toString('hex');
  const install = (server: any) => {
    const stores=new Map<string,DiskDraftStore>();
    const catalog = new ProjectCatalog(server.config.root);
    server.middlewares.use(async (req: any, res: any, next: () => void) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (!url.pathname.startsWith('/api/draft/')) return next();
      const json = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('Content-Type','application/json'); res.setHeader('Cache-Control','no-store'); res.end(JSON.stringify(body)); };
      // Local disk operations are not available to LAN clients or foreign sites.
      const host = req.headers.host || '';
      let hostname: string;
      try { hostname = new URL(`http://${host}`).hostname; } catch { return json(400,{error:'Invalid host'}); }
      const remote = req.socket.remoteAddress || '';
      if (!['localhost','127.0.0.1','[::1]'].includes(hostname) || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)) return json(403,{error:'Local access only'});
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return json(403,{error:'Origin mismatch'});
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(403,{error:'Cross-site request rejected'});
      try {
        const root=projectRoot(server.config.root,req.headers['x-project-id']);
        let store=stores.get(root);if(!store){store=new DiskDraftStore(root);stores.set(root,store);}
        if (url.pathname === '/api/draft/session' && req.method === 'GET') return json(200,{ token, storage: '.podcast-drafts', protocol: 1 });
        if (req.headers['x-draft-token'] !== token) return json(401,{error:'Draft session expired'});
        if (url.pathname === '/api/draft/projects') {
          if (req.method === 'GET') return json(200, { projects: await catalog.list() });
          if (req.method !== 'POST' && req.method !== 'PATCH') return json(405, { error: 'Unsupported project operation' });
          let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 8192) return json(413, { error: 'Project metadata too large' }); }
          const value = JSON.parse(body || '{}');
          if (req.method === 'POST') return json(201, { project: await catalog.create() });
          await catalog.rename(value.id, value.name); return json(200, { saved: true });
        }
        if (url.pathname === '/api/draft/asset' && req.method === 'POST') return json(200,await store.upload(req));
        if (url.pathname.startsWith('/api/draft/asset/') && req.method === 'GET') {
          const file = store.assetPath(url.pathname.split('/').pop()!);
          const stat = await fs.stat(file);
          res.setHeader('Content-Type','application/octet-stream'); res.setHeader('Content-Length',stat.size); res.setHeader('Cache-Control','no-store');
          const stream=createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);return;
        }
        if (url.pathname === '/api/draft/current' && req.method === 'GET') return json(200,await store.read());
        if (url.pathname === '/api/draft/current' && req.method === 'PUT') {
          const chunks: Buffer[]=[];let bytes=0;
          for await (const chunk of req) { bytes+=chunk.length;if(bytes>32*1024**2) return json(413,{error:'Draft metadata exceeds 32MB'});chunks.push(chunk); }
          const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!Array.isArray(body.assets) || (body.expectedRevision !== null && typeof body.expectedRevision !== 'string')) return json(400,{error:'Invalid draft commit'});
          const snapshot=await store.save(body.payload,body.assets,body.expectedRevision);
          return json(200,{revision:snapshot.revision,savedAt:snapshot.savedAt,assetCount:snapshot.assets.length});
        }
        return json(405,{error:'Unsupported draft operation'});
      } catch(e) { return json(e instanceof DraftConflict ? 409 : 500,{error:e instanceof Error?e.message:String(e)}); }
    });
  };
  return { name:'local-disk-drafts', configureServer: install, configurePreviewServer: install };
}
