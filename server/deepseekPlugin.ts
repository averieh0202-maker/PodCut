/**
 * Vite dev-server middleware: POST /api/deepseek/duplicates
 * Body: { words: [{ id, text, index? }] }
 * Secrets stay in process.env / .env.local — never shipped to the browser.
 */
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DeepSeekError,
  detectDuplicates,
  readDeepSeekKey,
  type DupWordInput,
} from './deepseekDup';

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

async function handleDup(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '请使用 POST /api/deepseek/duplicates' });
    return;
  }

  if (!readDeepSeekKey(env)) {
    sendJson(res, 503, {
      error: '请先在 .env.local 配置 DEEPSEEK_API_KEY，然后重启 npm run dev',
      code: 'MISSING_CREDENTIALS',
      hint: '把 DeepSeek API Key 粘贴进项目根目录 .env.local 的 DEEPSEEK_API_KEY=…，保存后重启开发服务器',
    });
    return;
  }

  try {
    const raw = await readRequestBody(req);
    const json = JSON.parse(raw.toString('utf8')) as {
      words?: DupWordInput[];
    };
    if (!json.words || !Array.isArray(json.words)) {
      sendJson(res, 400, { error: 'JSON 体需包含 words 数组' });
      return;
    }
    const result = await detectDuplicates(json.words, env);
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof DeepSeekError) {
      sendJson(res, err.httpStatus && err.httpStatus >= 400 ? err.httpStatus : 502, {
        error: err.message,
        code: err.code,
      });
      return;
    }
    if (err instanceof SyntaxError) {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }
    console.error('[deepseek-dup] unexpected', err);
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : 'DeepSeek 服务异常',
    });
  }
}

export function deepseekDupPlugin(env: NodeJS.ProcessEnv): Plugin {
  return {
    name: 'deepseek-dup-proxy',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (url !== '/api/deepseek/duplicates') {
          next();
          return;
        }
        req.setTimeout(0);
        res.setTimeout(0);
        void handleDup(req, res, env).catch((err) => {
          console.error('[deepseek-dup] handler crash', err);
          if (!res.headersSent) {
            sendJson(res, 500, { error: 'DeepSeek 服务异常' });
          }
        });
      });
    },
  };
}
