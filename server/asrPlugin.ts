/**
 * Vite dev-server middleware: POST /api/asr → Volcengine submit+query (or flash).
 * Secrets stay in process.env / .env.local — never shipped to the browser bundle.
 *
 * Body modes:
 * - raw audio bytes + X-Filename → audio.data base64 submit
 * - JSON { data: base64, filename? }
 * - JSON { url: "https://...", filename? } → audio.url submit (public link)
 *
 * Progress (B4): send header `X-Asr-Stream: 1` (or Accept: application/x-ndjson)
 * to receive NDJSON lines: {type:'progress',...} then {type:'result',...} or {type:'error',...}.
 */
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  readVolcCredsFromEnv,
  recognize,
  VolcAsrError,
  type AudioInput,
} from './volcAsr';

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function wantsNdjson(req: IncomingMessage): boolean {
  const stream = req.headers['x-asr-stream'];
  if (stream === '1' || stream === 'true') return true;
  const accept = (req.headers.accept || '').toLowerCase();
  return accept.includes('application/x-ndjson');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

function beginNdjson(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Transfer-Encoding', 'chunked');
  // Flush headers early so the client can start reading progress.
  if (typeof (res as ServerResponse & { flushHeaders?: () => void }).flushHeaders === 'function') {
    (res as ServerResponse & { flushHeaders: () => void }).flushHeaders();
  }
}

function writeNdjson(res: ServerResponse, body: unknown): void {
  if (res.writableEnded) return;
  res.write(`${JSON.stringify(body)}\n`);
}

function isPublicHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function handleAsr(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Filename, X-Audio-Format, X-Asr-Stream, Accept',
    );
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '请使用 POST /api/asr 上传音频或传 URL' });
    return;
  }

  const stream = wantsNdjson(req);
  const creds = readVolcCredsFromEnv(env);
  if (!creds) {
    const body = {
      error: '请先配置火山引擎密钥',
      code: 'MISSING_CREDENTIALS',
      hint: '在项目根目录创建 .env.local，写入 VOLC_APP_KEY（X-Api-Key），VOLC_RESOURCE_ID=volc.seedasr.auc，然后重启 npm run dev',
    };
    if (stream) {
      beginNdjson(res);
      writeNdjson(res, { type: 'error', ...body });
      res.end();
    } else {
      sendJson(res, 503, body);
    }
    return;
  }

  try {
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    let input: AudioInput | null = null;
    let filename = 'audio.wav';

    const headerName = req.headers['x-filename'];
    if (typeof headerName === 'string' && headerName.trim()) {
      try {
        filename = decodeURIComponent(headerName.trim());
      } catch {
        filename = headerName.trim();
      }
    }

    if (contentType.includes('application/json')) {
      const raw = await readRequestBody(req);
      const json = JSON.parse(raw.toString('utf8')) as {
        filename?: string;
        data?: string;
        url?: string;
        mime?: string;
      };
      if (json.filename) filename = json.filename;

      if (json.url?.trim()) {
        const url = json.url.trim();
        if (!isPublicHttpUrl(url)) {
          const errBody = { error: 'url 必须是 http(s) 公网地址' };
          if (stream) {
            beginNdjson(res);
            writeNdjson(res, { type: 'error', ...errBody });
            res.end();
          } else {
            sendJson(res, 400, errBody);
          }
          return;
        }
        input = { kind: 'url', url, filename };
      } else if (json.data) {
        input = {
          kind: 'data',
          buffer: Buffer.from(json.data, 'base64'),
          filename,
        };
      } else {
        const errBody = {
          error: 'JSON 体需包含 data（base64）或 url（公网音频链接）',
        };
        if (stream) {
          beginNdjson(res);
          writeNdjson(res, { type: 'error', ...errBody });
          res.end();
        } else {
          sendJson(res, 400, errBody);
        }
        return;
      }
    } else {
      const audio = await readRequestBody(req);
      const fmt = req.headers['x-audio-format'];
      if (typeof fmt === 'string' && fmt && !/\.[a-z0-9]+$/i.test(filename)) {
        filename = `${filename}.${fmt.replace(/^\./, '')}`;
      }
      input = { kind: 'data', buffer: audio, filename };
    }

    if (!input || (input.kind === 'data' && input.buffer.length === 0)) {
      const errBody = { error: '未收到音频数据' };
      if (stream) {
        beginNdjson(res);
        writeNdjson(res, { type: 'error', ...errBody });
        res.end();
      } else {
        sendJson(res, 400, errBody);
      }
      return;
    }

    console.log(
      `[asr] mode=${creds.mode} resource=${creds.resourceId} via=${input.kind} stream=${stream}`,
    );

    if (stream) {
      beginNdjson(res);
      const result = await recognize(input, creds, {
        onProgress: (ev) => {
          writeNdjson(res, { type: 'progress', ...ev });
        },
      });
      writeNdjson(res, { type: 'result', ...result });
      res.end();
      return;
    }

    const result = await recognize(input, creds);
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof VolcAsrError) {
      const body = {
        error: err.message,
        code: err.statusCode,
      };
      if (stream && !res.headersSent) {
        beginNdjson(res);
        writeNdjson(res, { type: 'error', ...body });
        res.end();
      } else if (stream && res.headersSent) {
        writeNdjson(res, { type: 'error', ...body });
        res.end();
      } else {
        sendJson(
          res,
          err.httpStatus && err.httpStatus >= 400 ? err.httpStatus : 502,
          body,
        );
      }
      return;
    }
    console.error('[asr] unexpected', err);
    const body = {
      error: err instanceof Error ? err.message : '转写服务异常',
    };
    if (stream && !res.headersSent) {
      beginNdjson(res);
      writeNdjson(res, { type: 'error', ...body });
      res.end();
    } else if (stream && res.headersSent) {
      writeNdjson(res, { type: 'error', ...body });
      res.end();
    } else {
      sendJson(res, 500, body);
    }
  }
}

export function volcAsrPlugin(env: NodeJS.ProcessEnv): Plugin {
  return {
    name: 'volc-asr-proxy',
    configureServer(server: ViteDevServer) {
      // Long-running submit+query — avoid premature socket timeouts where possible
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (url !== '/api/asr') {
          next();
          return;
        }
        // Node default headers timeout can kill long polls; bump for this route
        req.setTimeout(0);
        res.setTimeout(0);
        void handleAsr(req, res, env).catch((err) => {
          console.error('[asr] handler crash', err);
          if (!res.headersSent) {
            sendJson(res, 500, { error: '转写服务异常' });
          } else if (!res.writableEnded) {
            try {
              res.write(
                `${JSON.stringify({ type: 'error', error: '转写服务异常' })}\n`,
              );
              res.end();
            } catch {
              /* */
            }
          }
        });
      });
    },
  };
}
