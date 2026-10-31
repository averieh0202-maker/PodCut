/**
 * 火山引擎（豆包语音）录音文件识别 — 前端只走本地代理 /api/asr
 *
 * 标准版 2.0：
 * - submit: POST .../api/v3/auc/bigmodel/submit
 * - query:  POST .../api/v3/auc/bigmodel/query
 * - Header: X-Api-Key + X-Api-Resource-Id: volc.seedasr.auc
 * - show_utterances: true → utterances[].words[]（毫秒）
 * - enable_punc: true → 标点在 utterance.text；代理会合并进 words 并标 breakAfter
 *
 * 本地文件：代理用 audio.data（base64）提交；也可传公网 url。
 * 密钥只放 .env.local（VOLC_APP_KEY），勿加 VITE_ 前缀。
 *
 * Progress (B4): requests with X-Asr-Stream: 1 receive NDJSON progress events.
 */

export interface AsrWord {
  speakerId?: string;
  speakerName?: string;
  estimated?: boolean;
  text: string;
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  breakAfter?: boolean;
}

export interface AsrResult {
  words: AsrWord[];
  text: string;
  /** seconds */
  duration: number;
  utteranceEnds?: number[];
}

export interface AsrErrorBody {
  error?: string;
  code?: string;
  hint?: string;
}

export interface AsrProgressInfo {
  phase?: string;
  percent: number;
  poll?: number;
  maxPolls?: number;
}

export interface AsrRequestOpts {
  signal?: AbortSignal;
  onProgress?: (info: AsrProgressInfo) => void;
}

export function mapVolcWordsToApp(
  words: Array<{ text: string; start_time: number; end_time: number; speakerId?: string }>,
): AsrWord[] {
  return words.map((w) => ({
    text: w.text,
    speakerId: w.speakerId,
    start: w.start_time / 1000,
    end: w.end_time / 1000,
  }));
}

function asrErrorFromBody(body: AsrErrorBody, status: number): Error {
  if (body.code === 'MISSING_CREDENTIALS' || status === 503) {
    return new Error(body.error || '请先配置火山引擎密钥');
  }
  return new Error(body.error || `转写失败（HTTP ${status})`);
}

function normalizeResult(body: AsrResult & AsrErrorBody): AsrResult {
  if (!body.words || !Array.isArray(body.words)) {
    throw new Error('转写结果缺少字级时间戳');
  }
  return {
    words: body.words,
    text: body.text || body.words.map((w) => w.text).join(''),
    duration: body.duration || 0,
    utteranceEnds: body.utteranceEnds,
  };
}

/** Read NDJSON progress stream from /api/asr (X-Asr-Stream: 1). */
async function readAsrNdjson(
  res: Response,
  onProgress?: (info: AsrProgressInfo) => void,
): Promise<AsrResult> {
  if (!res.body) {
    throw new Error('转写响应无正文');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result: AsrResult | null = null;
  let streamError: Error | null = null;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      type?: string;
      percent?: number;
      phase?: string;
      poll?: number;
      maxPolls?: number;
      error?: string;
      code?: string;
      words?: AsrWord[];
      text?: string;
      duration?: number;
      utteranceEnds?: number[];
    };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'progress') {
      onProgress?.({
        phase: msg.phase,
        percent: Math.max(0, Math.min(100, Number(msg.percent) || 0)),
        poll: msg.poll,
        maxPolls: msg.maxPolls,
      });
      return;
    }
    if (msg.type === 'error') {
      streamError = asrErrorFromBody(
        { error: msg.error, code: msg.code },
        res.ok ? 502 : res.status,
      );
      return;
    }
    if (msg.type === 'result') {
      result = normalizeResult(msg as AsrResult & AsrErrorBody);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line);
    }
  }
  if (buf.trim()) handleLine(buf);

  if (streamError) throw streamError;
  if (!result) throw new Error('转写流未返回结果');
  onProgress?.({ phase: 'done', percent: 100 });
  return result;
}

async function parseAsrResponse(
  res: Response,
  opts?: AsrRequestOpts,
): Promise<AsrResult> {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/x-ndjson')) {
    return readAsrNdjson(res, opts?.onProgress);
  }

  let body: AsrResult & AsrErrorBody = {} as AsrResult & AsrErrorBody;
  try {
    body = (await res.json()) as AsrResult & AsrErrorBody;
  } catch {
    throw new Error(`转写失败（HTTP ${res.status}）`);
  }

  if (!res.ok) {
    throw asrErrorFromBody(body, res.status);
  }
  const result = normalizeResult(body);
  opts?.onProgress?.({ phase: 'done', percent: 100 });
  return result;
}

/** Upload local file → proxy uses audio.data base64 + submit/query. */
export async function transcribeViaProxy(
  file: File | Blob,
  filenameOrOpts?: string | AsrRequestOpts,
  maybeOpts?: AsrRequestOpts,
): Promise<AsrResult> {
  let filename = 'audio.wav';
  let opts: AsrRequestOpts | undefined;
  if (typeof filenameOrOpts === 'string') {
    filename = filenameOrOpts;
    opts = maybeOpts;
  } else {
    opts = filenameOrOpts;
    if (file instanceof File && file.name) filename = file.name;
  }

  const res = await fetch('/api/asr', {
    method: 'POST',
    headers: {
      'Content-Type': (file as File).type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(filename),
      'X-Asr-Stream': '1',
      Accept: 'application/x-ndjson, application/json',
    },
    body: file,
    signal: opts?.signal,
  });
  return parseAsrResponse(res, opts);
}

/** Public audio URL → proxy uses audio.url (Volcengine fetches it). */
export async function transcribeViaUrl(
  url: string,
  filenameOrOpts?: string | AsrRequestOpts,
  maybeOpts?: AsrRequestOpts,
): Promise<AsrResult> {
  let filename: string | undefined;
  let opts: AsrRequestOpts | undefined;
  if (typeof filenameOrOpts === 'string') {
    filename = filenameOrOpts;
    opts = maybeOpts;
  } else {
    opts = filenameOrOpts;
  }

  const res = await fetch('/api/asr', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Asr-Stream': '1',
      Accept: 'application/x-ndjson, application/json',
    },
    body: JSON.stringify({ url, filename }),
    signal: opts?.signal,
  });
  return parseAsrResponse(res, opts);
}
