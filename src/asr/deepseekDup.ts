/**
 * DeepSeek 重录检测 — 前端只走本地代理 /api/deepseek/duplicates
 * 密钥只放 .env.local（DEEPSEEK_API_KEY），勿加 VITE_ 前缀。
 */

export interface DupWordPayload {
  id: string;
  text: string;
  index: number;
  clipId?:string;
  start?:number;
  end?:number;
  breakAfter?:boolean;
}

export interface DuplicateSpan {
  startWordId: string;
  endWordId: string;
  reason: string;
}

export interface DupDetectResponse {
  duplicates: DuplicateSpan[];
  model?: string;
}

export interface DupErrorBody {
  error?: string;
  code?: string;
  hint?: string;
}

export async function detectDuplicatesViaProxy(
  words: DupWordPayload[],
): Promise<DupDetectResponse> {
  const res = await fetch('/api/deepseek/duplicates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ words }),
  });

  let body: DupDetectResponse & DupErrorBody = {} as DupDetectResponse & DupErrorBody;
  try {
    body = (await res.json()) as DupDetectResponse & DupErrorBody;
  } catch {
    throw new Error(`重录检测失败（HTTP ${res.status}）`);
  }

  if (!res.ok) {
    if (body.code === 'MISSING_CREDENTIALS' || res.status === 503) {
      throw new Error(
        body.hint ||
          body.error ||
          '请先在 .env.local 粘贴 DEEPSEEK_API_KEY，然后重启开发服务器',
      );
    }
    throw new Error(body.error || `重录检测失败（HTTP ${res.status}）`);
  }

  if (!Array.isArray(body.duplicates)) {
    throw new Error('检测结果格式异常');
  }
  return {
    duplicates: body.duplicates,
    model: body.model,
  };
}
