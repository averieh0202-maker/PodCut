import { restartPolicy } from './restartPolicy';
import { adjacentRetakes } from './adjacentRetakes';
/**
 * DeepSeek chat completions — detect retake / false-start duplicate spans
 * in a Chinese podcast transcript (word-indexed).
 *
 * Key stays in process.env / .env.local (DEEPSEEK_API_KEY). Never ship to browser.
 * Docs: https://api-docs.deepseek.com/
 */

export interface DupWordInput {
  id: string;
  text: string;
  /** 0-based index in the list we send (non-deleted words only). */
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

export interface DupDetectResult {
  duplicates: DuplicateSpan[];
  model: string;
  rawPreview?: string;
}

export class DeepSeekError extends Error {
  constructor(
    message: string,
    public code?: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';

export function readDeepSeekKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.DEEPSEEK_API_KEY?.trim() || '';
  return key || null;
}

export function readDeepSeekModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;
}

export function readDeepSeekBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE;
  return base.replace(/\/$/, '');
}

const SYSTEM_PROMPT = `你是播客剪辑助手。用户会给你一段带字级索引的中文播客文字稿。
任务：结合前后语义找出「重录 / 口误重来 / 假开头 / 中途改口后遗留的残句」——说话人没念好又重新念了一遍的内容。
这些重复往往措辞不完全一样（同义改写、多几个字、少几个标点），需要语义判断。

${restartPolicy}

规则：
1. 只标出应当删掉的那一段（通常是较早的失败尝试），保留最终成功的念法。
2. 不要把正常的强调重复、歌词式反复、专有名词复述标成重录。
3. 不要求后文逐字重复。识别未完成的因果、转折、主语或短语：说了开头后改变句式，前面的残句不再与后文衔接。
   例：「因为要不大家都去搞 Web coding 呢？因为这可以取代很多工作。」第一处「因为」是放弃的因果开头，接下来改为「要不…呢？」的提议；只标第一处「因为」，保留提议和后面的完整解释。
   例：「我觉得这个的作者是，是李明开发的。」标出前面未完成的「我觉得这个的作者是，」，保留后面完成的句子，范围只覆盖失败尝试。
   反例：「因为成本降低，所以采用它。因为速度也快，我们扩大了使用。」两处因果均完整，不标。
   反例：「很多很多的热点」可以是正常强调，不因重复就标。不要做泛泛的润色、删观点或替用户改写。
4. 特别检查相邻两次相同短句，前一次停下、后一次从头重说并继续：例如「同样，一个同样的模型。一个同样的模型，甚至同一套提示词」，标出前一处「同样，一个同样的模型」，保留后一次完整展开；不要把这种整句重录当成正常强调。换段、标点和停顿不会阻止匹配。
5. reason 写明放弃的句式或与后文的关系，不能只说“重复”。逐句扫描全文，包括短至一两个字的假开头。
6. 每个 span 用 startWordId / endWordId（含两端）标识；必须是用户提供的真实 id。
7. 只输出 JSON，格式严格为：
{"duplicates":[{"startWordId":"...","endWordId":"...","reason":"简短中文理由"}]}
若没有发现重录，返回 {"duplicates":[]}`;

function buildUserPrompt(words: DupWordInput[]): string {
  const lines = words.map((w,i) => `[${w.index}] id=${w.id} ${w.text}${w.breakAfter ? " <换段>" : ""}${i && w.start!==undefined && words[i-1]?.end!==undefined ? ` <前距${(w.start-words[i-1]!.end!).toFixed(2)}s>` : ""}`);
  // Compact continuous text for context
  const plain = words.map((w) => w.text+(w.breakAfter?'\n':'')).join('');
  return [
    '下面是字级索引（每行一个字/词）与连续全文。请找出需要删除的重录/假开头区间。',
    '',
    '=== 字级索引 ===',
    lines.join('\n'),
    '',
    '=== 连续全文 ===',
    plain,
  ].join('\n');
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new DeepSeekError('模型返回空内容', 'EMPTY', 502);
  // Prefer fenced ```json
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence?.[1]?.trim() || trimmed;
  // Find outermost { ... }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new DeepSeekError('模型未返回 JSON 对象', 'BAD_JSON', 502);
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new DeepSeekError('模型 JSON 解析失败', 'BAD_JSON', 502);
  }
}

function normalizeSpans(
  raw: unknown,
  idSet: Set<string>,
): DuplicateSpan[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { duplicates?: unknown };
  const list = Array.isArray(obj.duplicates) ? obj.duplicates : [];
  const out: DuplicateSpan[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const startWordId = String(row.startWordId ?? row.start_word_id ?? '').trim();
    const endWordId = String(row.endWordId ?? row.end_word_id ?? '').trim();
    const reason = String(row.reason ?? '疑似重录').trim() || '疑似重录';
    if (!startWordId || !endWordId) continue;
    if (!idSet.has(startWordId) || !idSet.has(endWordId)) continue;
    out.push({ startWordId, endWordId, reason });
  }
  return out;
}

/** Overlap preserves retakes at chunk seams; every word is visited. */
const MAX_WORDS = 1800;
const OVERLAP_WORDS = 200;

async function detectChunk(
  words: DupWordInput[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<DupDetectResult> {
  const apiKey = readDeepSeekKey(env);
  if (!apiKey) {
    throw new DeepSeekError(
      '请先配置 DeepSeek API Key',
      'MISSING_CREDENTIALS',
      503,
    );
  }
  if (!Array.isArray(words) || words.length === 0) {
    throw new DeepSeekError('没有可检测的文字稿', 'NO_WORDS', 400);
  }

  const sliced = words.map((w, i) => ({
    ...w,
    id: String(w.id),
    text: String(w.text ?? ''),
    index: typeof w.index === 'number' ? w.index : i,
  }));
  const idSet = new Set(sliced.map((w) => w.id));
  const model = readDeepSeekModel(env);
  const base = readDeepSeekBase(env);
  const url = `${base}/chat/completions`;

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(sliced) },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
    // Prefer non-thinking for cheaper/faster structured JSON when supported
    thinking: { type: 'disabled' },
    stream: false,
  };

  console.log(
    `[deepseek-dup] model=${model} words=${sliced.length} POST ${url}`,
  );

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  let parsed: {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string; code?: string };
  } = {};
  try {
    parsed = rawText ? (JSON.parse(rawText) as typeof parsed) : {};
  } catch {
    throw new DeepSeekError(
      `DeepSeek 返回非 JSON（HTTP ${res.status}）`,
      String(res.status),
      res.status,
    );
  }

  if (!res.ok) {
    const msg =
      parsed.error?.message ||
      (res.status === 401
        ? 'DeepSeek API Key 无效'
        : `DeepSeek 请求失败（HTTP ${res.status}）`);
    throw new DeepSeekError(msg, parsed.error?.code || String(res.status), res.status);
  }

  const content = parsed.choices?.[0]?.message?.content ?? '';
  const json = extractJsonObject(content);
  const duplicates = normalizeSpans(json, idSet);

  return {
    duplicates,
    model,
    rawPreview: content.slice(0, 400),
  };
}

export async function detectDuplicates(words: DupWordInput[], env: NodeJS.ProcessEnv = process.env): Promise<DupDetectResult> {
  if (!Array.isArray(words) || !words.length) throw new DeepSeekError('没有可检测的文字稿','NO_WORDS',400);
  const spans: DuplicateSpan[]=adjacentRetakes(words);
  let model=readDeepSeekModel(env);
  for(let start=0;start<words.length;start+=MAX_WORDS-OVERLAP_WORDS) {
    const chunk=words.slice(start,start+MAX_WORDS);
    const result=await detectChunk(chunk,env);model=result.model;
    const indices=new Map(chunk.map((w,i)=>[w.id,i]));
    for(const span of result.duplicates) {
      const a=indices.get(span.startWordId),b=indices.get(span.endWordId);
      if(a!==undefined && b!==undefined && a<=b) spans.push(span);
    }
    if(start+MAX_WORDS>=words.length) break;
  }
  const index=new Map(words.map((w,i)=>[w.id,i]));
  // Overlap can return the same attempt with slightly different endpoints.
  // Merge only intersecting suggestions, never bridge retained text.
  const sorted=spans.sort((a,b)=>index.get(a.startWordId)!-index.get(b.startWordId)!);
  const duplicates: DuplicateSpan[]=[];
  for(const span of sorted) {
    const last=duplicates.at(-1);
    if(last && index.get(span.startWordId)!<=index.get(last.endWordId)!) {
      if(index.get(span.endWordId)!>index.get(last.endWordId)!) last.endWordId=span.endWordId;
    } else duplicates.push({...span});
  }
  return {duplicates,model};
}
