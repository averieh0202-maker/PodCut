import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DiskDraftStore } from './diskDraftStore';
import { projectRoot } from './projectScope';
import { buildMixSchedule } from '../src/audio/mixSchedule';
import { tempoDuration } from '../src/audio/speechTempo';
import type { SavedProject } from '../src/edit/projectCatalog';

interface ProjectInfo { name: string; createdAt: number }
const validId = /^[a-z0-9][a-z0-9-]{0,79}$/;
export class ProjectCatalog {
  constructor(private readonly root: string) {}
  private async info(dir: string): Promise<ProjectInfo | null> {
    try { return JSON.parse(await fs.readFile(path.join(dir, 'project-info.json'), 'utf8')); } catch { return null; }
  }
  private async writeInfo(dir: string, info: ProjectInfo) {
    const target = path.join(dir, 'project-info.json'), temp = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(info)); await handle.sync(); await handle.close(); await fs.rename(temp, target); }
    finally { await handle.close().catch(() => {}); await fs.unlink(temp).catch(() => {}); }
  }
  private async summary(id: string): Promise<SavedProject | null> {
    const dir = projectRoot(this.root, id), info = await this.info(dir);
    let state: any;
    try { state = JSON.parse(await fs.readFile(path.join(dir, 'current.json'), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !info) return null;
      try { state = (await new DiskDraftStore(dir).read()).snapshot; }
      catch { return { id, name: info?.name || '待恢复的剪辑', createdAt: info?.createdAt || 0, savedAt: 0, clipCount: 0, musicCount: 0, duration: 0, wordCount: 0, preview: '原文件仍然保留，打开后查看恢复状态', empty: false, unavailable: true }; }
    }
    const p = state?.payload, clips = Array.isArray(p?.clips) ? p.clips : [];
    if (!clips.length && !info) return null;
    const music = Array.isArray(p?.music) ? p.music : [];
    const words = clips.flatMap((c: any) => Array.isArray(c.words) ? c.words.filter((w: any) => !w.deleted) : []);
    const sourceClip = clips.find((c: any) => !c.id?.startsWith('teaser-')) || clips[0];
    const dateMatch = id.match(/^episode-(\d{2})(\d{2})-/);
    const derivedName = p?.audioName && !/^podcast(?:-\d+clips)?$/.test(p.audioName) ? p.audioName
      : dateMatch ? `${Number(dateMatch[1])}.${Number(dateMatch[2])} 播客` : sourceClip?.name;
    let duration = 0;
    try {
      const buffer = (b: any, fallback = 0) => ({ duration: b?.length && b?.sampleRate ? b.length / b.sampleRate : fallback });
      duration = tempoDuration(buildMixSchedule(clips.map((c: any) => ({ ...c, buffer: buffer(c.current, c.duration) })), music.map((m: any) => ({ ...m, buffer: buffer(m.buffer, m.outPoint || m.duration) }))) as any, p?.speechRate ?? 1);
    } catch { duration = clips.reduce((sum: number, c: any) => sum + (c.ranges ?? []).reduce((n: number, r: any) => n + Math.max(0, r.end - r.start), 0), 0) / (p?.speechRate || 1); }
    return {
      id, name: info?.name || derivedName || '未命名剪辑', createdAt: info?.createdAt || state?.savedAt || 0,
      savedAt: state?.savedAt || info?.createdAt || 0, clipCount: clips.length, musicCount: music.length,
      duration: Number.isFinite(duration) ? duration : 0, wordCount: words.length,
      preview: words.slice(0, 90).map((w: any) => w.text).join(''), empty: !clips.length,
    };
  }
  async list(): Promise<SavedProject[]> {
    const rows = [await this.summary('')];
    const dirs = await fs.readdir(path.join(this.root, '.podcast-drafts', 'projects'), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    for (const dir of dirs) if (dir.isDirectory() && validId.test(dir.name)) rows.push(await this.summary(dir.name));
    return rows.filter((row): row is SavedProject => row !== null).sort((a, b) => b.savedAt - a.savedAt);
  }
  async create(): Promise<SavedProject> {
    const id = `edit-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`;
    const dir = projectRoot(this.root, id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await this.writeInfo(dir, { name: '', createdAt: Date.now() });
    await new DiskDraftStore(dir).save(null, [], null);
    return (await this.summary(id))!;
  }
  async rename(id: unknown, name: unknown): Promise<void> {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw Error('剪辑名称需为 1–120 个字');
    const dir = projectRoot(this.root, id);
    if (typeof id !== 'string' || !await this.summary(id)) throw Error('剪辑不存在');
    const previous = await this.info(dir);
    await this.writeInfo(dir, { name: name.trim(), createdAt: previous?.createdAt || Date.now() });
  }
}
