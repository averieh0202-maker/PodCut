/** A browser-side download only: no credentials or audio are sent to an AI service. */
export function parseAudioUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('请输入以 http:// 或 https:// 开头的音频直链'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请使用不含账号密码的 HTTP 或 HTTPS 音频直链');
  }
  return url;
}

function decodeName(name: string): string {
  try { return decodeURIComponent(name); } catch { return name; }
}

export function audioFileName(url: URL, disposition = ''): string {
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  const name = decodeName(encoded || plain?.[1] || plain?.[2]?.trim() || url.pathname.split('/').pop() || 'URL音频');
  return name.replace(/[\\/\x00-\x1f]/g, '_').trim().slice(0, 180) || 'URL音频';
}

export async function downloadAudioFile(raw: string, request: typeof fetch = fetch): Promise<File> {
  const url = parseAudioUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await request(url.href, { credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error(`音频链接返回 HTTP ${response.status}`);
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (mime === 'text/html' || mime === 'application/json') throw new Error('这个链接返回的是网页，请换成音频文件的直链');
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) throw new Error('链接返回了空文件');
    return new File([bytes], audioFileName(url, response.headers.get('content-disposition') || ''), { type: mime || 'application/octet-stream' });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('音频下载超时，请重试或从本地导入');
    if (error instanceof TypeError) throw new Error('无法读取链接；请使用允许跨域访问的音频直链，或下载后从本地导入');
    throw error;
  } finally { clearTimeout(timer); }
}
