export interface SavedProject {
  id: string;
  name: string;
  savedAt: number;
  createdAt: number;
  clipCount: number;
  musicCount: number;
  duration: number;
  wordCount: number;
  preview: string;
  empty: boolean;
  unavailable?: boolean;
}

let token: string | undefined;
async function request(init?: RequestInit) {
  if (!token) {
    const response = await fetch('/api/draft/session', { cache: 'no-store' });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw Error('请启动 PodCut 本机服务后查看历史剪辑');
    token = (await response.json()).token;
  }
  const response = await fetch('/api/draft/projects', {
    ...init, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Draft-Token': token!, ...init?.headers },
  });
  if (response.status === 401 && token) { token = undefined; throw Error('保存服务已重启，请刷新重试'); }
  const value = await response.json();
  if (!response.ok) throw Error(value.error || '历史剪辑读取失败');
  return value;
}
export async function listSavedProjects(): Promise<SavedProject[]> { return (await request()).projects; }
export async function createSavedProject(): Promise<SavedProject> { return (await request({ method: 'POST', body: '{}' })).project; }
export async function renameSavedProject(id: string, name: string): Promise<void> { await request({ method: 'PATCH', body: JSON.stringify({ id, name }) }); }
export function editorHref(id: string): string { return id ? `/?project=${encodeURIComponent(id)}` : '/?editor=legacy'; }
