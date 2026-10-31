import '../styles.css';
import '../themes.css';
import './projectHome.css';
import { mountThemeControls } from './theme';
import { icon } from './icons';
import { listSavedProjects, createSavedProject, renameSavedProject, editorHref, type SavedProject } from '../edit/projectCatalog';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.className = 'project-home';
document.title = '历史剪辑 · PodCut';
app.innerHTML = `
  <header class="home-topbar">
    <a class="home-brand" href="/" aria-label="PodCut 主页"><span class="brand-symbol" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="brand-name">PodCut</span></a>
    <div class="theme-switch" role="group" aria-label="界面主题">
      <button type="button" class="theme-choice" data-theme-choice="light" aria-label="明亮" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.1"/><path d="M10 1.7v1.5m0 13.6v1.5M1.7 10h1.5m13.6 0h1.5M4.1 4.1l1.1 1.1m9.6 9.6 1.1 1.1M4.1 15.9l1.1-1.1m9.6-9.6 1.1-1.1"/></svg><span>明亮</span></button>
      <button type="button" class="theme-choice" data-theme-choice="dark" aria-label="深夜" aria-pressed="false"><svg aria-hidden="true" viewBox="0 0 20 20"><path d="M17 11.1A7.2 7.2 0 0 1 8.9 3a7.2 7.2 0 1 0 8.1 8.1Z"/></svg><span>深夜</span></button>
    </div>
  </header>
  <main class="home-content">
    <div class="home-heading"><div><h1>历史剪辑</h1><p>每一期的进度，都会留在这里。</p></div><button class="btn btn-primary" id="new-project">＋ 新建剪辑</button></div>
    <div class="home-list-tools"><p id="project-count" aria-live="polite">正在读取剪辑…</p><input type="search" id="project-search" placeholder="搜索剪辑" aria-label="搜索剪辑名称或内容" /></div>
    <div class="home-error" id="home-error" role="alert" hidden><p id="home-error-message"></p><button class="btn" id="retry-projects">重新读取</button><a href="/?editor=legacy">打开浏览器草稿</a></div>
    <div class="project-list" id="project-list" aria-label="历史剪辑"><p class="home-loading">正在读取已保存的工程…</p></div>
    <p class="home-save-note">编辑时自动保存，回到主页也会保存本期剪辑。</p>
  </main>
  <dialog class="project-name-dialog" id="rename-dialog" aria-labelledby="rename-title"><form id="rename-form"><h2 id="rename-title">重命名剪辑</h2><label for="project-name">剪辑名称</label><input id="project-name" name="name" maxlength="120" required autocomplete="off" /><p id="rename-error" role="alert" hidden></p><div class="rename-actions"><button type="button" class="btn" id="cancel-rename">取消</button><button type="submit" class="btn btn-primary" id="save-project-name">保存</button></div></form></dialog>
`;
mountThemeControls();
let projects: SavedProject[] = [];
let renamingId = '';
const list = document.querySelector<HTMLDivElement>('#project-list')!;
const count = document.querySelector<HTMLParagraphElement>('#project-count')!;
const search = document.querySelector<HTMLInputElement>('#project-search')!;
const error = document.querySelector<HTMLDivElement>('#home-error')!;
const newButton = document.querySelector<HTMLButtonElement>('#new-project')!;
const dialog = document.querySelector<HTMLDialogElement>('#rename-dialog')!;
const nameInput = document.querySelector<HTMLInputElement>('#project-name')!;
const nameError = document.querySelector<HTMLParagraphElement>('#rename-error')!;
function text(value: unknown) { return String(value ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]!); }
function duration(seconds: number) { const n = Math.max(0, Math.round(seconds)); return n >= 3600 ? `${Math.floor(n/3600)}:${String(Math.floor(n/60)%60).padStart(2,'0')}:${String(n%60).padStart(2,'0')}` : `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`; }
function savedAt(time: number) { return time ? new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '待恢复'; }
function render() {
  const query = search.value.trim().toLocaleLowerCase();
  const rows = projects.filter(p => `${p.name} ${p.preview}`.toLocaleLowerCase().includes(query));
  count.textContent = query ? `找到 ${rows.length} 期剪辑` : `${projects.length} 期剪辑`;
  if (!rows.length) {
    list.innerHTML = `<div class="home-empty"><h2>${query ? '没有找到这期剪辑' : '开始你的第一期播客'}</h2><p>${query ? '试试其他名称或文稿中的词。' : '新建剪辑，导入录音。下次打开就能接着剪。'}</p></div>`;
    return;
  }
  list.innerHTML = `<div class="project-list-labels" aria-hidden="true"><span>剪辑</span><span>成片时长</span><span>最近保存</span><span></span><span></span></div>` + rows.map(p => `
    <article class="project-row${p.unavailable ? ' needs-recovery' : ''}">
      <a class="project-open" href="${editorHref(p.id)}" aria-label="继续编辑：${text(p.name)}">
        <div class="project-description"><h2>${text(p.name)}</h2><p class="project-preview">${text(p.preview || (p.empty ? '还没有导入音频' : '已保存剪辑进度'))}</p><span class="project-detail">${p.clipCount} 个片段${p.musicCount ? ` · ${p.musicCount} 处配乐` : ''}${p.unavailable ? ' · 待恢复' : ''}</span></div>
        <span class="project-duration">${p.empty || p.unavailable ? '—' : duration(p.duration)}</span>
        <time class="project-saved"${p.savedAt ? ` datetime="${new Date(p.savedAt).toISOString()}"` : ''}>${savedAt(p.savedAt)}</time>
        <span class="project-continue" aria-hidden="true">${icon('arrow')}</span>
      </a>
      <button class="btn project-rename" data-project-id="${text(p.id)}" aria-label="重命名：${text(p.name)}" title="重命名剪辑">${icon('edit')}</button>
    </article>`).join('');
}
async function load() {
  error.hidden = true;
  try { projects = await listSavedProjects(); render(); }
  catch (cause) { showError(cause); list.innerHTML = ''; count.textContent = '暂时无法读取'; }
}
function showError(cause: unknown) { error.hidden = false; document.querySelector('#home-error-message')!.textContent = cause instanceof Error ? cause.message : String(cause); }
search.addEventListener('input', render);
document.querySelector('#retry-projects')!.addEventListener('click', () => void load());
newButton.addEventListener('click', async () => {
  newButton.disabled = true; newButton.textContent = '正在新建…';
  try { location.assign(editorHref((await createSavedProject()).id)); }
  catch (cause) { showError(cause); newButton.disabled = false; newButton.textContent = '＋ 新建剪辑'; }
});
list.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-project-id]');
  if (!button) return;
  const project = projects.find(p => p.id === button.dataset.projectId);
  if (!project) return;
  renamingId = project.id; nameInput.value = project.name; nameError.hidden = true; dialog.showModal(); nameInput.select();
});
document.querySelector('#cancel-rename')!.addEventListener('click', () => dialog.close());
document.querySelector('#rename-form')!.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector<HTMLButtonElement>('#save-project-name')!;
  button.disabled = true;
  try { await renameSavedProject(renamingId, nameInput.value); dialog.close(); await load(); }
  catch (cause) { nameError.hidden = false; nameError.textContent = cause instanceof Error ? cause.message : String(cause); }
  finally { button.disabled = false; }
});
window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
void load();
