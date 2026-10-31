// @ts-nocheck
import {startLocalExport,latestLocalExport,localExportStatus} from './audio/localExport';
import {mountPublicationExport} from './edit/publicationClient';
import { mixedWords, musicCoverage } from './audio/musicCoverage';
import { episodeSegments } from './edit/episodeTimeline';
import './styles.css';
import './themes.css';
import {mountThemeControls} from './ui/theme';
import {ToolbarNotice} from './ui/toolbarNotice';
import {icon} from './ui/icons';
import {scopeSpeakers, listSpeakers, groupSpeakerUtterances, applySpeakerLabels, UNKNOWN_SPEAKER} from './edit/speakers';
import {saveAndLeave} from './edit/saveAndLeave';
import {downloadAudioFile, parseAudioUrl} from './audio/urlImport';
import { mountRoughCut } from './ui/roughCut';
import { pauseExceedsThreshold, bulkPauseParts } from './edit/pauses';
import { analyzeClipPauses } from './edit/pauseAnalysis';
import { selectedWordElements, selectWordSpan } from './edit/wordSelection';
import { replacePauseCut, deletePauseParts, pauseDeletionCuts } from './edit/pauseEditing';
import { deleteWordRuns, restoreWordRuns, repairLegacyDeletedAudio, repairDeletedEdges } from './edit/deleteRuns';
import { AudioEngine } from './audio/engine';
import { downloadBlob, exportEditedWav, exportMixedWav } from './audio/exportAudio';
import {
  BED_FADE_IN_DEFAULT,
  BED_FADE_OUT_DEFAULT,
  BED_GAIN_DB_DEFAULT,
  STINGER_FADE_IN_DEFAULT,
  STINGER_FADE_OUT_DEFAULT,
  STINGER_GAIN_DB_DEFAULT,
  buildMixSchedule,
  resolveMusicFades,
  resolveMusicRegion,
  resolveSpeechEditTime,
  resolveMusicAnchorTime,
  musicAnchorSide,
} from './audio/mixSchedule';
import {
  DEMO_SFX,
  SFX_TAGS,
  addSfxToLibrary,
  deleteSfxFromLibrary,
  getSfxBlob,
  listSfxLibrary,
  markDemoSfxSeeded,
  updateSfxMeta,
  wasDemoSfxSeeded,
  type SfxLibraryMeta,
  type SfxTag,
} from './audio/sfxLibrary';
import {
  GAIN_DB_DEFAULT,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  clampGainDb,
  dbToLinear,
  formatGainDb,
} from './audio/gain';
import {
  applyVoiceProcessing,
  concatAudioBuffers,
  glueRangesFromBuffer,
} from './audio/denoise';
import {
  cloneRanges,
  cloneWords,
  extractRanges,
  extractEditRanges,
  fullRange,
  insertRangesAt,
  addRange,
  removeRange,
  wordAtOriginal,
  editedDuration,
  toEdit,
} from './edit/timeline';
import { updateWordBoundary } from './edit/wordBoundary';
import { ensureAudioOrder } from './edit/audioOrder';
import { UndoStack } from './edit/history';
import {
  buildMultiClipTranscript,
  exportMultiMd,
  exportMultiTxt,
} from './edit/exportTranscript';
import type {
  Clip,
  MusicKind,
  MusicPlacement,
  ProjectState,
  TranscriptFile,
  Word,
} from './edit/types';
import { transcribeViaProxy, transcribeViaUrl } from './asr/volcengine';
import { detectDuplicatesViaProxy } from './asr/deepseekDup';
import {
  clearDraftPayload,
  draftToProject,
  loadDraftPayload,
  projectToDraft,
  saveDraftPayload,
  slimDraftForQuota,
} from './edit/draftStore';
import {
  cutExtentsForIds,
  isPunctText,
  viewWindowAround,
  wordCutExtent,
} from './edit/alignment';
import { refineWordBoundariesFromBuffer } from './edit/refineBoundaries';
import { alignmentFingerprint, requestForcedAlignment, applyForcedAlignment } from './edit/forcedAlignment';
import { bufferAcoustics } from './edit/acoustics';
import { pauseGroupDisplay, detectPauses, singlePauseCut, groupPauseMarks } from './edit/pauses';
import { characterWords } from './edit/tokenize';
import { DraftWriter } from './edit/draftWriter';
import { draftStorageKind, draftRevision } from './edit/draftDisk';

const engine = new AudioEngine();
const undo = new UndoStack();
let project = null;
let draftSaveTimer = 0;
let draftHeartbeatTimer = 0;
let draftBootReady = false;
let draftAllowClear = false;
let draftRecoveryBlocked = false;
let draftSaveFailToastAt = 0;
const draftWriter = new DraftWriter(async () => {
  if (draftRecoveryBlocked) throw new Error("旧草稿有未恢复音频，已保留原文件；请先重新导入缺失音频或明确清空项目");
  setDraftStatus("saving", "正在保存到本机…");
  if (!project?.clips?.length) {
    if (draftAllowClear) { await clearDraftPayload(); draftAllowClear = false; }
    return;
  }
  const payload = slimDraftForQuota(projectToDraft({ project, activeClipId, clipIdSeq, musicIdSeq }));
  // Server receipt is issued only after audio verification + atomic fsync commit.
  await saveDraftPayload(payload);
});
function setDraftStatus(state, label, detail = "") {
  const badge = document.querySelector("#draft-status");
  if (!badge) return;
  badge.dataset.state = state;
  badge.textContent = label;
  badge.title = detail || "点击立即保存草稿；本机目录 .podcast-drafts";
}
function scheduleDraftSave() {
  draftWriter.markDirty();
  setDraftStatus("pending", "有更改 · 等待保存");
  window.clearTimeout(draftSaveTimer);
  draftSaveTimer = window.setTimeout(() => void flushDraftSave(), 400);
}
function ensureDraftHeartbeat() {
  if (draftHeartbeatTimer) return;
  draftHeartbeatTimer = window.setInterval(() => {
    if (draftBootReady && draftWriter.dirty && !draftWriter.saving) void flushDraftSave({toastFail:false});
  }, 8000);
}
async function flushDraftSave(opts = {}) {
  if (!draftBootReady) return false;
  try {
    await draftWriter.flush();
    setDraftStatus("saved", draftStorageKind() === "disk" ? "已保存到本机" : "已存浏览器缓存");
    if (opts.toastOk) toast(draftStorageKind() === "disk" ? "草稿已写入 Mac 磁盘，可刷新恢复" : "已保存到浏览器缓存", 3500);
    return true;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn("draft save failed", e);
    setDraftStatus("error", "保存未完成 · 点击重试", detail);
    if (opts.toastFail !== false && Date.now() - draftSaveFailToastAt > 5000) {
      draftSaveFailToastAt = Date.now();
      toast(`草稿未保存：${detail.slice(0, 100)}。请保持页面打开。`, 6500);
    }
    return false;
  }
}
async function persistDraftCritical() {
  scheduleDraftSave(); window.clearTimeout(draftSaveTimer); ensureDraftHeartbeat();
  return flushDraftSave({toastOk:true});
}
function schedulePostRestorePersist() {
  if (draftStorageKind() === "disk") {
    if (!draftRecoveryBlocked) setDraftStatus("saved", "已保存到本机");
    return;
  }
  window.setTimeout(() => {
    if (draftBootReady && project?.clips?.length) {
      if (!draftRecoveryBlocked) { scheduleDraftSave(); void flushDraftSave({toastFail:true}); }
    }
  }, 0);
}
async function tryRestoreDraft() {
  try {
    const draft = await loadDraftPayload();
    if (!draft || !draft.clips?.length) return false;
    const restored = await draftToProject(draft, {
      decode: (ab) => engine.decodeArrayBuffer(ab),
      loadSfxBlob: (id) => getSfxBlob(id),
      applyFx: (clean, flags) =>
        applyVoiceProcessing(clean, {
          denoise: flags.denoise,
          beautify: flags.beautify,
        }),
    });
    engine.stop();
    undo.clear();
    project = restored.project;
    await engine.setPlaybackRate(project.speechRate ?? 1);
    document.querySelector("#playback-speed").value=String(engine.getPlaybackRate());
    let repairedAudio=0, upgradedDeletion=false;
    if(!restored.failedClips?.length)for(const clip of project.clips){
      if((clip.legacyDeletionRepairVersion??0)>=2)continue;
      let snapshotted=false;
      const beforeRepair=()=>{if(!snapshotted){pushUndo(clip);snapshotted=true;}};
      if(!clip.legacyDeletionRepairVersion)repairedAudio+=repairLegacyDeletedAudio(clip,beforeRepair);
      repairedAudio+=repairDeletedEdges(clip,beforeRepair);
      clip.legacyDeletionRepairVersion=2;upgradedDeletion=true;
    }
    activeClipId = restored.activeClipId;
    clipIdSeq = Math.max(clipIdSeq, restored.clipIdSeq);
    musicIdSeq = Math.max(musicIdSeq, restored.musicIdSeq);
    activeWordId = null;
    pasteSide = "after";
    activeMusicId = null;
    dupFlaggedIds = new Set();
    dupFlagReasons = new Map();
    wordClipboard = null;
    engine.setFallbackUrl(null);
    if (project.clips.length === 1 && project.clips[0].sourceBlob) {
      try {
        engine.setFallbackUrl(URL.createObjectURL(project.clips[0].sourceBlob));
      } catch {
        /* */
      }
    }
    engine.setGain(dbToLinear(project.gainDb));
    syncGainUi(getActiveClip()?.gainDb ?? 0);
    refreshAfterClipsChange({persist:false});
    const when = new Date(draft.savedAt);
    const label = Number.isFinite(draft.savedAt)
      ? when.toLocaleString("zh-CN", { hour12: false })
      : "刚才";
    const failed = restored.failedClips || [];
    if (failed.length) {
      draftRecoveryBlocked = true;
      setDraftStatus("error", "部分音频未恢复 · 原稿已保留");
      const names = failed.map((f) => f.name).join("、");
      const mb = failed[0]?.sourceBytes
        ? `（约 ${(failed[0].sourceBytes / (1024 * 1024)).toFixed(0)}MB）`
        : "";
      toast(
        `已恢复 ${project.clips.length} 段；「${names}」音频无法解码${mb}，请重新导入该段`,
        8000,
      );
    } else {
      toast(`已打开剪辑（${label} · ${project.clips.length} 段）`, 4500);
    }
    schedulePostRestorePersist();
    if(upgradedDeletion)scheduleDraftSave();
    if(repairedAudio>1e-6){toast(`已修复旧剪辑切口残音 ${repairedAudio.toFixed(2)}s · 正在保存，可撤销`,5000);}
    return true;
  } catch (e) {
    draftRecoveryBlocked = true;
    setDraftStatus("error", "恢复失败 · 原稿已保留");
    console.warn("draft restore failed", e);
    const msg = e instanceof Error ? e.message : String(e);
    toast(`草稿恢复失败：${msg.slice(0, 120)}`, 7000);
    return false;
  }
}
let thresholdSec = 0.55;
try {
  const saved=localStorage.getItem("podcut.pauseThreshold");
  if(saved!==null && Number.isFinite(Number(saved))) thresholdSec=Math.max(.3,Math.min(1.5,Number(saved)));
} catch { /* Browser storage may be unavailable; the control still works. */ }
let activeWordId = null;
let pasteSide = "after";
let activeClipId = null;
let readingWordId = null;
let activePause = null;
let dragMusicId = null;
let musicPointerDrag = null;
let suppressMusicClickUntil = 0;
const alignmentJobs = new Map();
const speakerJobs = new Map();
const speakerMessages = new Map();
let speakerPanelKey = null;
const boundaryEditVersions = new Map();
const alignmentMessages = new Map();
let alignmentQueue = Promise.resolve();
let clipIdSeq = 0;
let dragClipId = null;
let musicIdSeq = 0;
let activeMusicId = null;
let sfxLibrary = [];
let dragLibraryId = null;
let detectingDuplicates = false;
let dupFlaggedIds = new Set();
let dupFlagReasons = new Map();
let wordClipboard = null;
let wordIdSeq = 0;
let dropAnchor = null;
let pendingDrop = null;
/** Background ASR jobs shown in left rail (B3/B4). */
let asrJobs = [];
let asrQueueRunning = false;
let importWatchdog = 0;
/** B10: word audio rail selection in original-clip seconds. */
let wordRailState = null;
let wordRailDrag = null;
let pauseIdSeq = 0;
const libraryBuffers = new Map();
const app = document.querySelector("#app");
if (!app) throw new Error("missing #app");
app.className = "shell";
app.innerHTML = `
  <header class="topbar">
    <div class="topbar-brand">
      <span class="brand-symbol" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><h1 class="brand-name">PodCut</h1>
      <span class="sub">播客剪辑工作台</span>
    </div>
    <div class="topbar-actions">
      <button type="button" class="local-badge draft-status" id="draft-status" data-state="idle">本机草稿 · 等待音频</button>
      <div class="menu" data-menu="export">
        <button type="button" class="btn btn-primary menu-trigger" id="btn-export-menu" disabled aria-haspopup="true" aria-expanded="false">导出 ▾</button>
        <div class="menu-panel menu-panel-right" id="export-menu" hidden role="menu">
          <button type="button" class="menu-item" id="btn-export-audio" disabled role="menuitem">导出剪辑音频</button>
          <a class="menu-item" id="download-last-audio" role="menuitem" hidden>下载上次导出</a>
          <button type="button" class="menu-item" id="btn-export-txt" disabled role="menuitem">导出文字稿</button>
          <button type="button" class="menu-item" id="btn-export-article" role="menuitem">导出播客长文稿</button><button type="button" class="menu-item" id="btn-export-notes" role="menuitem">导出简介与时间戳</button>
          <button type="button" class="menu-item" id="btn-export-md" disabled role="menuitem">导出 Markdown</button>
        </div>
      </div>
      <div class="menu" data-menu="more">
        <button type="button" class="btn btn-ghost menu-trigger" id="btn-more-menu" aria-haspopup="true" aria-expanded="false" title="更多">⋯</button>
        <div class="menu-panel menu-panel-right" id="more-menu" hidden role="menu">
          <button type="button" class="menu-item" id="btn-paste-start" hidden disabled role="menuitem">粘贴到开头</button>
          <button type="button" class="menu-item" id="btn-clear" disabled role="menuitem">清空项目</button>
        </div>
      </div>
      <button type="button" class="btn btn-icon" id="btn-help" title="帮助与说明" aria-expanded="false">?</button>
      <button type="button" class="btn btn-ghost btn-sm rail-toggle" id="btn-rail-toggle" title="片段/素材">左栏</button>
      <button type="button" class="btn btn-ghost btn-sm insp-toggle" id="btn-insp-toggle" title="效果面板">效果</button>
      <div class="theme-switch" role="group" aria-label="界面主题">
        <button type="button" class="theme-choice" data-theme-choice="light" aria-label="明亮" aria-pressed="false" title="明亮版"><svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.1"/><path d="M10 1.7v1.5m0 13.6v1.5M1.7 10h1.5m13.6 0h1.5M4.1 4.1l1.1 1.1m9.6 9.6 1.1 1.1M4.1 15.9l1.1-1.1m9.6-9.6 1.1-1.1"/></svg><span>明亮</span></button>
        <button type="button" class="theme-choice" data-theme-choice="dark" aria-label="深夜" aria-pressed="false" title="深夜版"><svg aria-hidden="true" viewBox="0 0 20 20"><path d="M17 11.1A7.2 7.2 0 0 1 8.9 3a7.2 7.2 0 1 0 8.1 8.1Z"/></svg><span>深夜</span></button>
      </div>
    </div>
  </header>

  <div class="transport" id="controls">
    <div class="transport-main">
      <div class="transport-edit" role="group" aria-label="播放与剪辑">
      <button type="button" class="btn btn-primary transport-symbol" id="btn-play" disabled aria-label="播放" aria-pressed="false" title="播放 · 空格">${icon('play')}</button>
      <button type="button" class="btn transport-symbol" id="btn-pause" disabled aria-label="暂停" title="暂停 · 空格">${icon('pause')}</button>
      <button type="button" class="btn transport-symbol" id="btn-undo" disabled aria-label="撤销" title="撤销 ⌘/Ctrl+Z">${icon('undo')}</button>
      <button type="button" class="btn transport-symbol" id="btn-redo" disabled aria-label="重做" title="重做 ⌘/Ctrl+Shift+Z">${icon('redo')}</button>
      <button type="button" class="btn" id="btn-delete-sel" disabled>删除</button><button type="button" class="btn" id="btn-restore-sel" disabled>复原</button>
      </div>
      <button type="button" class="btn btn-ghost home-button" id="btn-home" aria-label="回到主页" title="保存本期剪辑并回到主页">${icon('home')}<span>回到主页</span></button>
      <button type="button" class="btn" id="btn-remove-pauses" hidden disabled title="删除超过设定时长的停顿，两端保留不单独显示的护音余量。Shift 仅处理当前片段">删除停顿</button>
      <button type="button" class="btn" id="btn-align-clip" hidden title="重新校准全部片段的所有自动字界；保留手动字界和剪辑">校准字界</button>
      <button type="button" class="btn" id="btn-detect-dup" hidden disabled title="用 DeepSeek 检查全部片段的重复、重录与假开头；绿色下划线标记，不自动删除">标记重复</button>
      <button type="button" class="btn" id="btn-agent-cut">Agent 初剪</button>
      <button type="button" class="btn btn-icon" id="btn-copy-sel" hidden disabled title="复制选中文字+音频 ⌘/Ctrl+C">⎘</button>
      <button type="button" class="btn btn-icon" id="btn-paste-words" hidden disabled title="粘贴文字+音频 ⌘/Ctrl+V">⤵</button>
    </div>
    <div class="toolbar-notice" id="toast" role="status" aria-live="polite" hidden></div>
    <div class="status-capsules" aria-label="项目状态">
      <span class="capsule">播放 <strong id="stat-head">—</strong></span>
      <span class="capsule">原始 <strong id="stat-orig">—</strong></span>
      <span class="capsule">剪后 <strong id="stat-edit">—</strong></span>
      <span class="capsule muted" title="片段数">片 <strong id="stat-clips">—</strong></span>
      <span class="capsule muted" title="剩余字数">字 <strong id="stat-words">—</strong></span>
    </div>
  </div>

  <aside class="rail" id="rail"><div class="section-eyebrow">项目</div>
    <div class="rail-tabs" role="tablist">
      <button type="button" class="rail-tab is-active" id="rail-tab-clips" role="tab" aria-selected="true" data-tab="clips">片段</button>
      <button type="button" class="rail-tab" id="rail-tab-sfx" role="tab" aria-selected="false" data-tab="sfx">素材</button>
    </div>
    <div class="rail-pane" id="rail-pane-clips" role="tabpanel">
      <div class="rail-import">      <div class="menu" data-menu="import">
        <button type="button" class="btn btn-primary menu-trigger" id="btn-import-menu" aria-haspopup="true" aria-expanded="false">＋ 导入音频 ▾</button>
        <div class="menu-panel" id="import-menu" hidden role="menu">
          <button type="button" class="menu-item" id="btn-upload" role="menuitem">本地文件</button>
          <button type="button" class="menu-item" id="btn-demo" role="menuitem">加载演示</button>
          <div class="menu-sep"></div>
          <div class="menu-row">
            <input type="url" id="audio-url" class="url-input" aria-label="片段音频 URL" placeholder="音频文件 URL" />
            <button type="button" class="btn btn-sm" id="btn-url">URL 导入</button>
          </div>
        </div>
      </div>
      <input type="file" id="file-audio" class="file-input" accept="audio/*,.wav,.mp3,.m4a,.webm" multiple />
      </div>
      <section class="panel track-panel" id="track-panel" hidden>
        <div class="track-header">
          <strong>拼接轨道</strong>
          <span class="hint">拖拽调序 · 点击定位</span>
        </div>
        <div class="track" id="track" role="list"></div>
      </section>
      <p class="rail-empty hint" id="rail-clips-empty">导入音频后，多段会出现在这里</p>
    </div>
    <div class="rail-pane" id="rail-pane-sfx" role="tabpanel" hidden>
      <section class="sfx-panel" id="sfx-panel">
        <div class="rail-import">
          <div class="menu" data-menu="sfx-import">
            <button type="button" class="btn btn-primary menu-trigger" id="btn-sfx-import-menu" aria-haspopup="true" aria-expanded="false">＋ 导入音频 ▾</button>
            <div class="menu-panel" id="sfx-import-menu" hidden role="menu">
              <button type="button" class="menu-item" id="btn-sfx-add" role="menuitem">本地文件</button>
              <button type="button" class="menu-item" id="btn-sfx-demo" role="menuitem">加载演示</button>
              <div class="menu-sep"></div>
              <div class="menu-row">
                <input type="url" id="sfx-audio-url" class="url-input" aria-label="素材音频 URL" placeholder="音频文件 URL" />
                <button type="button" class="btn btn-sm" id="btn-sfx-url">URL 导入</button>
              </div>
              <p class="import-url-status" id="sfx-url-status" role="status" hidden></p>
            </div>
          </div>
          <input type="file" id="file-sfx" class="file-input" accept="audio/*,.wav,.mp3,.m4a,.webm" multiple />
        </div>
        <div class="track-header"><strong>常用音频</strong></div>
        <div class="sfx-toolbar">
          <label class="threshold">标签
            <select id="sfx-tag-default">
              <option value="开头">开头</option>
              <option value="过场" selected>过场</option>
              <option value="结尾">结尾</option>
              <option value="自定义">自定义</option>
            </select>
          </label>
        </div>
        <p class="hint rail-sfx-hint">拖到字上：背景叠人声 · 过场不盖；Shift 松开＝过场</p>
        <div class="sfx-list" role="list" id="sfx-list" data-placeholder="还没有常用音频…"></div>
      </section>
    </div>
  </aside>

  <main class="canvas">
    <div class="editor-heading"><span>文字稿</span><span class="editor-legend">单击开字音轨 · Delete 删字 <kbd>Space</kbd> 播放</span></div>
    <section class="empty-state" id="empty-state"><div class="empty-wave" aria-hidden="true">${[12,22,38,60,32,80,48,96,62,40,72,32,50,24,12].map(h => `<i style="height:${h}px"></i>`).join('')}</div><div class="section-eyebrow">YOUR NEXT EPISODE STARTS HERE</div><h2>从一段声音开始</h2><p>导入录音，将声音化为文字。<br>删字、留白、调节节奏，让表达更自然。</p><div class="empty-actions"><button type="button" class="btn btn-primary" data-click-id="btn-upload">＋ 导入音频</button><button type="button" class="btn" data-click-id="btn-demo">体验演示 ↗</button></div><span class="empty-formats">WAV · MP3 · M4A · WEBM</span></section>
    <div class="selection-bar" id="selection-bar" hidden>
      <span class="sel-label">已选文字</span>
      <button type="button" class="btn btn-sm" data-click-id="btn-delete-sel">删除</button>
      <button type="button" class="btn btn-sm" data-click-id="btn-copy-sel">复制</button>
      <button type="button" class="btn btn-sm" data-click-id="btn-detect-dup" hidden>标重复</button>
    </div>
    <details class="hint-fold">
      <summary>操作提示（单击选中 · Delete 删字 · 拖选 · 空格播放）</summary>
      <p class="hint">
        单击一字即选中（高亮），按 <code>Delete</code>/<code>Backspace</code> 删除该字并同步剪音频；拖选多字后同样可删。单击即可打开右侧字音轨，查看波形并调整字界。
        <code>⌘/Ctrl+C</code> 复制文字+音频；点字左半或开头 <code>|</code>＝插到前面，右半＝后面；「粘贴到开头」在更多菜单。
        <code>空格</code> 播放/暂停。停顿标签可单独删除，↶ 可复原。智能删除处理超过设定时长的停顿。
        「标重复」用 DeepSeek 标重录/假开头。
        从「素材」拖到文字：松开选<strong>背景</strong>或<strong>过场</strong>；Shift 松开＝过场。点 ♪/✦ 调音量/截取/渐入渐出。
      </p>
    </details>
    <div class="music-inspector" id="music-inspector" hidden>
      <div class="music-inspector-head">
        <strong id="music-inspector-title">选中音频</strong>
        <span class="music-kind-badge" id="music-inspector-kind"></span>
        <span class="hint" id="music-inspector-anchor"></span><button type="button" class="btn btn-sm" id="music-anchor-before" aria-pressed="false">字前</button><button type="button" class="btn btn-sm" id="music-anchor-after" aria-pressed="false">字后</button>
        <button type="button" class="btn btn-sm" id="btn-music-remove">移除素材</button><button type="button" class="btn btn-sm btn-ghost" id="btn-music-close" aria-label="收起素材编辑">收起 ×</button>
      </div>
      <div class="music-inspector-row">
        <label class="threshold">音量
          <input type="range" id="music-gain" min="-36" max="12" step="0.5" value="-15" />
          <span id="music-gain-val">−15 dB</span>
        </label>
        <label class="threshold">起始
          <input type="number" id="music-in" min="0" step="0.1" value="0" />
          <span>s</span>
        </label>
        <label class="threshold">结束
          <input type="number" id="music-out" min="0.1" step="0.1" value="3" />
          <span>s</span>
        </label>
        <span class="hint" id="music-clip-len">选区 3.0s / 素材 3.0s</span>
      </div>
      <div class="music-inspector-row">
        <label class="threshold">渐入
          <input type="number" id="music-fade-in" min="0" max="30" step="0.1" value="2" />
          <span>s</span>
        </label>
        <label class="threshold">渐出
          <input type="number" id="music-fade-out" min="0" max="30" step="0.1" value="2" />
          <span>s</span>
        </label>
        <label id="music-lead-label">音乐先行 <input type="number" id="music-lead" min="0" max="30" step="0.1" value="0" /> s</label><span class="hint" id="music-fade-hint">背景默认 2 / 2s</span>
      </div>
      <div class="music-end-location"><span id="music-end-label"></span><button class="btn btn-sm" id="music-end-jump" type="button">定位结束位置</button></div>
      <div id="music-entry-preview" class="music-entry-preview" hidden><div class="music-entry-music">♫ 背景音乐</div><div id="music-entry-voice" class="music-entry-voice"></div></div>
      <div class="music-region-bar" aria-hidden="true">
        <div class="music-region-track">
          <div class="music-region-fill" id="music-region-fill"></div>
        </div>
        <input type="range" id="music-in-range" class="music-region-range" min="0" max="1000" step="1" value="0" />
        <input type="range" id="music-out-range" class="music-region-range" min="0" max="1000" step="1" value="1000" />
      </div>
    </div>
    <div
      class="transcript"
      id="transcript"
      tabindex="0"
      data-placeholder="导入音频或加载演示开始…"
      aria-label="可编辑文字稿"
    ></div>
  </main>

  <aside class="inspector" id="inspector"><div class="section-eyebrow">剪辑工具</div>
    <details class="insp-group" id="word-rail-group" open>
      <summary>字音轨 · 边界精修</summary><div class="alignment-controls"><button type="button" class="btn btn-sm btn-ghost" id="btn-cancel-alignment" hidden>取消</button><span class="hint" id="alignment-status" role="status">原音 + 文字逐字对齐</span></div><p class="word-rail-empty hint" id="word-rail-empty">点击文稿中的任意字，在这里查看原音波形、试听并调整边界。</p>
      <div class="insp-body word-rail" id="word-rail" hidden>
        <div class="word-rail-head">
          <strong id="word-rail-label">—</strong>
          <span class="hint" id="word-rail-meta"></span>
        </div>
        <div class="word-rail-wave-wrap" id="word-rail-wave-wrap">
          <canvas id="word-rail-canvas" width="240" height="56" aria-label="字音频波形"></canvas>
          <div class="word-rail-sel" id="word-rail-sel" hidden></div>
          <div class="word-rail-handle left" id="word-rail-h-left" title="左边界"></div>
          <div class="word-rail-handle right" id="word-rail-h-right" title="右边界"></div>
        </div>
        <div class="word-rail-times">
          <span id="word-rail-t0">0.00s</span>
          <span id="word-rail-tsel">选区 —</span>
          <span id="word-rail-t1">0.00s</span>
        </div>
        <div class="boundary-inputs"><label>起点 <input id="boundary-start" type="number" min="0" step="0.005" /></label><label>终点 <input id="boundary-end" type="number" min="0" step="0.005" /></label></div><span class="sr-only" id="word-boundary-status" role="status"></span>

      </div>
    </details>
    <details class="insp-group" hidden>
      <summary>节奏整理</summary>
      <div class="insp-body">
        <button type="button" class="btn btn-block" data-click-id="btn-remove-pauses" hidden disabled id="btn-remove-pauses-side">删除停顿</button>
        <label class="threshold">
          处理长于
          <input type="range" id="threshold" min="0.3" max="1.5" step="0.05" value="${thresholdSec}" />
          <span id="threshold-val">${thresholdSec.toFixed(2)}s</span>
        </label><p class="hint tool-note">停顿包含静音和吸气，同一处合并显示并按总时长判断；低于 0.10s 不标记。超过设定时长直接删除，两端各留约 0.01s 护音，不单独显示。点击停顿可删除，↶ 复原，∿ 调整边界。</p><div class="pause-summary" id="pause-summary">导入音频后分析停顿</div>
      </div>
    </details>
    <details class="insp-group">
      <summary>片段音频处理</summary>
      <div class="insp-body">
        <p class="hint processing-target" id="processing-target">先选择一个片段</p>

        <label class="threshold" title="仅调整当前片段的音量">
          音量
          <input type="range" id="gain" min="${GAIN_DB_MIN}" max="${GAIN_DB_MAX}" step="0.5" value="${GAIN_DB_DEFAULT}" autocomplete="off" />
          <span id="gain-val">${formatGainDb(GAIN_DB_DEFAULT)}</span>
        </label>
        <button type="button" class="btn btn-toggle" id="btn-denoise" disabled title="温和降噪：降低当前人声片段的底噪与嘶声，不影响配乐（可还原）" aria-pressed="false">降噪</button>
        <button type="button" class="btn btn-toggle" id="btn-beautify" disabled title="人声美化：轻微清晰度提升 + 柔化齿音高频 + 轻压缩（可还原）" aria-pressed="false">美化</button>
        <div class="voice-speed-setting">
          <label class="playback-speed" title="输入 0.5–2 倍，可自由设置。应用于全期人声试听与导出，不改变音调；插入音乐始终原速。"><span>人声倍速</span><span class="speed-field"><input id="playback-speed" type="number" min="0.5" max="2" step="0.01" value="1" inputmode="decimal" aria-label="人声播放速度" /><span aria-hidden="true">×</span></span></label>
          <p class="hint speed-scope">全期人声 · 试听与导出 · 配乐原速</p>
        </div>
      </div>
    </details>
    <details class="insp-group" id="speaker-group">
      <summary>说话人</summary>
      <div class="insp-body speaker-panel">
        <p class="hint processing-target" id="speaker-target">先选择一个片段</p>
        <div id="speaker-list" class="speaker-list"></div>
        <button type="button" class="btn btn-block" id="btn-speakers" disabled>识别说话人</button>
        <p class="hint" id="speaker-status" role="status">新导入录音会自动区分说话人。</p>
        <p class="hint speaker-note">编号按每段录音分别识别，可改为姓名；多人同时讲话时可能需要核对。</p>
      </div>
    </details>
    <details class="insp-group" hidden>
      <summary>文稿整理</summary>
      <div class="insp-body">
        <p class="hint">顶部「标记重复」检查全部片段，以绿色下划线标出疑似重录，不自动删字。</p>
        <button type="button" class="btn btn-block" id="btn-clear-dup" disabled title="清除重复下划线标记（不删字）">清除重复标记</button>
      </div>
    </details>
  </aside>

  <aside class="help-drawer" id="help-drawer" hidden>
    <div class="help-head">
      <strong>帮助</strong>
      <button type="button" class="btn btn-icon" id="btn-help-close" title="关闭">×</button>
    </div>
    <div class="help-body">
      <p>上传经本地代理调用<strong>火山引擎</strong>豆包录音文件识别 2.0（字级时间戳）。可多次添加音频到拼接轨道；本地文件走 <code>audio.data</code>；也可粘贴公网 URL。</p>
      <p>在 <code>.env.local</code> 配置 <code>VOLC_APP_KEY</code> 与 <code>DEEPSEEK_API_KEY</code>（重录检测）后重启 <code>npm run dev</code>。开源包不附带演示朗读，请导入自己的录音。已有本机演示文件仍可离线加载。</p>
      <p>快捷键：空格播放/暂停 · 单击选中后 Delete 删字 · ⌘Z 撤销 · ⌘Shift+Z 重做 · ⌘C/V 复制粘贴 · Shift+松开放过场。</p>
    </div>
  </aside>

  <div class="drawer-backdrop" id="drawer-backdrop" hidden></div>
`;
mountThemeControls();

const el = {
  demo: $("#btn-demo"),
  upload: $("#btn-upload"),
  clear: $("#btn-clear"),
  file: $("#file-audio"),
  audioUrl: $("#audio-url"),
  urlBtn: $("#btn-url"),
  play: $("#btn-play"),
  pause: $("#btn-pause"),
  gain: $("#gain"),
  gainVal: $("#gain-val"),
  denoise: $("#btn-denoise"),
  beautify: $("#btn-beautify"),
  removePauses: $("#btn-remove-pauses"),
  threshold: $("#threshold"),
  thresholdVal: $("#threshold-val"),
  detectDup: $("#btn-detect-dup"),
  clearDup: $("#btn-clear-dup"),
  deleteSel: $("#btn-delete-sel"),
  restoreSel: $("#btn-restore-sel"),
  copySel: $("#btn-copy-sel"),
  pasteWords: $("#btn-paste-words"),
  pasteStart: $("#btn-paste-start"),
  undo: $("#btn-undo"),
  redo: $("#btn-redo"),
  exportTxt: $("#btn-export-txt"),
  exportMd: $("#btn-export-md"),
  exportAudio: $("#btn-export-audio"),
  trackPanel: $("#track-panel"),
  track: $("#track"),
  musicInspector: $("#music-inspector"),
  musicInspectorTitle: $("#music-inspector-title"),
  musicInspectorKind: $("#music-inspector-kind"),
  musicInspectorAnchor: $("#music-inspector-anchor"),
  musicGain: $("#music-gain"),
  musicGainVal: $("#music-gain-val"),
  musicIn: $("#music-in"),
  musicOut: $("#music-out"),
  musicClipLen: $("#music-clip-len"),
  musicFadeIn: $("#music-fade-in"),
  musicFadeOut: $("#music-fade-out"),
  musicFadeHint: $("#music-fade-hint"),
  musicInRange: $("#music-in-range"),
  musicOutRange: $("#music-out-range"),
  musicRegionFill: $("#music-region-fill"),
  musicRemove: $("#btn-music-remove"),
  sfxPanel: $("#sfx-panel"),
  sfxAdd: $("#btn-sfx-add"),
  sfxDemo: $("#btn-sfx-demo"),
  sfxFile: $("#file-sfx"),
  sfxTagDefault: $("#sfx-tag-default"),
  sfxList: $("#sfx-list"),
  transcript: $("#transcript"),
  toast: $("#toast"),
  statOrig: $("#stat-orig"),
  statEdit: $("#stat-edit"),
  statHead: $("#stat-head"),
  statClips: $("#stat-clips"),
  statWords: $("#stat-words"),
  exportMenuBtn: $("#btn-export-menu"),
  selectionBar: $("#selection-bar"),
  helpDrawer: $("#help-drawer"),
  helpBtn: $("#btn-help"),
  helpClose: $("#btn-help-close"),
  rail: $("#rail"),
  inspectorEl: $("#inspector"),
  backdrop: $("#drawer-backdrop"),
  railTabClips: $("#rail-tab-clips"),
  railTabSfx: $("#rail-tab-sfx"),
  railPaneClips: $("#rail-pane-clips"),
  railPaneSfx: $("#rail-pane-sfx"),
  railClipsEmpty: $("#rail-clips-empty"),
  railToggle: $("#btn-rail-toggle"),
  inspToggle: $("#btn-insp-toggle"),
  removePausesSide: $("#btn-remove-pauses-side"),
  wordRailGroup: $("#word-rail-group"),
  wordRailLabel: $("#word-rail-label"),
  wordRailMeta: $("#word-rail-meta"),
  wordRailWrap: $("#word-rail-wave-wrap"),
  wordRailCanvas: $("#word-rail-canvas"),
  wordRailSel: $("#word-rail-sel"),
  wordRailHLeft: $("#word-rail-h-left"),
  wordRailHRight: $("#word-rail-h-right"),
  wordRailT0: $("#word-rail-t0"),
  wordRailT1: $("#word-rail-t1"),
  wordRailTSel: $("#word-rail-tsel"),

};
function $(sel) {
  const node = document.querySelector(sel);
  if (!node) throw new Error(`missing ${sel}`);
  return node;
}
const toolbarNotice = new ToolbarNotice(el.toast);
function toast(msg, ms = 3500) {
  toolbarNotice.show(msg, { duration: ms });
}
function closeAllMenus() {
  document.querySelectorAll(".menu-panel").forEach((p) => {
    p.hidden = true;
  });
  document.querySelectorAll(".menu-trigger").forEach((b) => {
    b.setAttribute("aria-expanded", "false");
  });
}
function toggleMenu(trigger, panel) {
  const open = panel.hidden;
  closeAllMenus();
  if (open) {
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  }
}
document.querySelectorAll(".menu").forEach((menu) => {
  const trigger = menu.querySelector(".menu-trigger");
  const panel = menu.querySelector(".menu-panel");
  if (!trigger || !panel) return;
  trigger.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleMenu(trigger, panel);
  });
  panel.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.closest("button.menu-item, a.menu-item") && !t.disabled) {
      if (panel.id !== "import-menu" || t.id === "btn-demo" || t.id === "btn-upload") {
        closeAllMenus();
      }
    }
  });
});
document.addEventListener("click", (ev) => {
  const t = ev.target;
  if (!t.closest(".menu")) closeAllMenus();
});
function setRailTab(tab) {
  const clips = tab === "clips";
  el.railTabClips.classList.toggle("is-active", clips);
  el.railTabSfx.classList.toggle("is-active", !clips);
  el.railTabClips.setAttribute("aria-selected", clips ? "true" : "false");
  el.railTabSfx.setAttribute("aria-selected", clips ? "false" : "true");
  el.railPaneClips.hidden = !clips;
  el.railPaneSfx.hidden = clips;
}
el.railTabClips.addEventListener("click", () => setRailTab("clips"));
el.railTabSfx.addEventListener("click", () => setRailTab("sfx"));
function isDrawerLayout() {
  return window.matchMedia("(max-width: 980px)").matches;
}
/** Backdrop only for help drawer or mobile rail/inspector overlays — never for desktop B10 rail. */
function syncDrawerBackdrop() {
  const drawerUi =
    isDrawerLayout() &&
    (el.rail.classList.contains("is-open") ||
      el.inspectorEl.classList.contains("is-open"));
  const need = !el.helpDrawer.hidden || drawerUi;
  el.backdrop.hidden = !need;
}

function setHelpOpen(open) {
  el.helpDrawer.hidden = !open;
  el.helpBtn.setAttribute("aria-expanded", open ? "true" : "false");
  syncDrawerBackdrop();
}
el.helpBtn.addEventListener("click", () => setHelpOpen(el.helpDrawer.hidden));
el.helpClose.addEventListener("click", () => setHelpOpen(false));
function closeDrawers() {
  el.rail.classList.remove("is-open");
  el.inspectorEl.classList.remove("is-open");
  syncDrawerBackdrop();
}
el.railToggle.addEventListener("click", () => {
  el.inspectorEl.classList.remove("is-open");
  el.rail.classList.toggle("is-open");
  syncDrawerBackdrop();
});
el.inspToggle.addEventListener("click", () => {
  el.rail.classList.remove("is-open");
  el.inspectorEl.classList.toggle("is-open");
  syncDrawerBackdrop();
});
el.backdrop.addEventListener("click", () => {
  closeDrawers();
  setHelpOpen(false);
});
document.addEventListener("click", (ev) => {
  const t = ev.target;
  const proxy = t.closest("[data-click-id]");
  if (!proxy) return;
  const id = proxy.dataset.clickId;
  if (!id) return;
  ev.preventDefault();
  const target = document.getElementById(id);
  if (target && !target.disabled) {
    // Preserve modifiers (B7: Shift＝仅当前段 for 清停顿)
    target.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        shiftKey: !!ev.shiftKey,
        altKey: !!ev.altKey,
        metaKey: !!ev.metaKey,
        ctrlKey: !!ev.ctrlKey,
      }),
    );
  }
});
function syncWordSelectedClasses(nodes) {
  const next=new Set(nodes);
  for(const node of el.transcript.querySelectorAll(".word.is-selected"))if(!next.has(node))node.classList.remove("is-selected");
  for(const node of next)if(!node.classList.contains("is-selected"))node.classList.add("is-selected");
}
function syncSelectionBar() {
  el.selectionBar.hidden = true;
  el.restoreSel.hidden = false;
  const nodes=selectedWordElements(el.transcript,window.getSelection());
  if(!nodes.length&&activeWordId){const node=el.transcript.querySelector(`.word[data-id="${CSS.escape(activeWordId)}"]`);if(node)nodes.push(node);}
  el.restoreSel.disabled=activePause ? !(activePause.cleared||activePause.removedParts?.length) : !nodes.some(n=>n.classList.contains('deleted'));
  el.restoreSel.textContent="复原";
  syncWordSelectedClasses(nodes);
}
document.addEventListener("selectionchange", () => syncSelectionBar());
el.transcript.addEventListener("mouseup", () => syncSelectionBar());
el.transcript.addEventListener("keyup", () => syncSelectionBar());
function fmt(sec) {
  if (!Number.isFinite(sec)) return "—";
  sec = Math.round(sec * 10) / 10;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
function syncGainUi(db) {
  const v = clampGainDb(db);
  el.gain.value = String(v);
  el.gainVal.textContent = formatGainDb(v);
}
function ensureProject() {
  if (!project) {
    project = { clips: [], speechRate: engine.getPlaybackRate(), gainDb: GAIN_DB_DEFAULT, audioName: "podcast", music: [] };
  }
  if (!project.music) project.music = [];
  for (const clip of project.clips) clip.words = clip.words.flatMap(w => w.deleted ? [w] : characterWords([w]));
  return project;
}
function nextMusicId() {
  musicIdSeq += 1;
  return `m${musicIdSeq}`;
}
function getActiveClip() {
  if (!project || project.clips.length === 0) return null;
  if (activeClipId) {
    const found = project.clips.find((c) => c.id === activeClipId);
    if (found) return found;
  }
  return project.clips[0] ?? null;
}
function setActiveClip(id) {
  activeClipId = id;
  renderTrack();
  syncDenoiseButton();
  syncBeautifyButton();
  syncAlignmentUi();
}
function nextClipId() {
  clipIdSeq += 1;
  return `c${clipIdSeq}`;
}
function clipSnapshot(clip) {
  ensureAudioOrder(clip);
  return {
    clipId: clip.id,
    words: clip.words,
    ranges: clip.ranges,
    audioOrder: clip.audioOrder,
    duration: clip.duration,
    manualPauses: clip.manualPauses ?? [],
    clearedPauses: clip.clearedPauses ?? []
  };
}
function pushUndo(clip) {
  undo.push(clipSnapshot(clip));
  syncChrome();
}
function normalizeMusicAnchors() {
  for (const m of project?.music ?? []) {
    const clip = project.clips.find(c => c.id === m.clipId);
    if (clip && !m.anchorSide) m.anchorSide = musicAnchorSide(m, clip.words);
  }
}
function syncEngineFromProject(opts) {
  normalizeMusicAnchors();
  if (!project || project.clips.length === 0) {
    engine.setClips([]);
    engine.setMixSchedule(null);
    return;
  }
  if (!project.music) project.music = [];
  const resume = opts?.resume !== false;
  const wasPlaying = engine.isPlaying();
  const t = engine.getEditTime();
  const master = dbToLinear(project.gainDb);
  for (const clip of project.clips) ensureAudioOrder(clip);
  const scheduleClips = project.clips.map((c) => ({
    id: c.id,
    buffer: c.buffer,
    ranges: c.ranges,
    words: c.words,
    gainDb: c.gainDb ?? 0
  }));
  const mix = buildMixSchedule(scheduleClips, project.music, master);
  engine.setMixSchedule(mix);
  engine.setClips(
    project.clips.map((c) => ({ buffer: c.buffer, ranges: c.ranges }))
  );
  engine.setGain(master);
  if (resume && wasPlaying) {
    engine.play(Math.min(t, Math.max(0, engine.getEditDuration() - 0.01)));
  }
}
function totalOrigDuration() {
  if (!project) return 0;
  return project.clips.reduce((s, c) => s + (c.audioOrder?.length ? editedDuration(c.audioOrder) : c.duration), 0);
}
function totalEditDuration() {
  if (!project) return 0;
  return engine.getOutputDuration();
}
function totalWordCount() {
  if (!project) return 0;
  return project.clips.reduce(
    (s, c) => s + c.words.filter((w) => !w.deleted).length,
    0
  );
}
function syncChrome() {
  const ready = !!project && project.clips.length > 0;
  document.querySelector("#playback-speed").disabled=!ready;
  syncAlignmentUi();
  app.classList.toggle("has-project", ready);
  if (!engine.isPlaying()) setReadingHighlight(null);
  el.play.disabled = !ready;
  el.pause.disabled = !ready;
  el.removePauses.disabled = !ready;
  el.removePausesSide.disabled = !ready;
  el.detectDup.disabled = !ready || detectingDuplicates;
  el.clearDup.disabled = !ready || dupFlaggedIds.size === 0;
  el.exportTxt.disabled = !ready;
  el.exportMd.disabled = !ready;
  el.exportAudio.disabled = !ready;
  el.exportMenuBtn.disabled = !ready;
  el.deleteSel.disabled = !ready;
  el.copySel.disabled = !ready;
  el.pasteWords.disabled = !ready || !wordClipboard;
  el.pasteStart.disabled = !ready || !wordClipboard;
  el.clear.disabled = !ready;
  el.denoise.disabled = !ready;
  el.beautify.disabled = !ready;
  el.undo.disabled = !ready || !undo.canUndo;
  el.redo.disabled = !ready || !undo.canRedo;
  el.play.setAttribute('aria-pressed', String(engine.isPlaying()));
  el.play.title = engine.isPlaying() ? '正在播放 · 空格暂停' : '播放 · 空格';
  syncTrackPanelVisibility();
  syncSelectionBar();
  if (!ready) {
    document.querySelector("#pause-summary").textContent = "导入音频后分析停顿";
    el.statOrig.textContent = "—";
    el.statEdit.textContent = "—";
    el.statHead.textContent = "—";
    el.statClips.textContent = "—";
    el.statWords.textContent = "—";
    syncDenoiseButton();
    syncBeautifyButton();
    return;
  }
  el.statOrig.textContent = fmt(totalOrigDuration());
  el.statEdit.textContent = fmt(totalEditDuration());
  el.statHead.textContent = fmt(engine.getOutputTime());
  el.statClips.textContent = String(project.clips.length);
  el.statWords.textContent = String(totalWordCount());
  syncDenoiseButton();
  syncBeautifyButton();
}
function syncDenoiseButton() {
  renderSpeakerInspector();
  const clip = getActiveClip();
  syncGainUi(clip?.gainDb ?? 0);
  el.gain.disabled = !clip;
  const target = document.querySelector("#processing-target");
  target.textContent = clip ? `仅处理「${clip.name}」` : "先选择一个片段";
  target.title = target.textContent;
  if (!clip) {
    el.denoise.textContent = "降噪";
    el.denoise.classList.remove("btn-active", "is-on");
    el.denoise.setAttribute("aria-pressed", "false");
    return;
  }
  el.denoise.textContent = clip.denoised ? "降噪·开" : "降噪";
  el.denoise.classList.toggle("btn-active", clip.denoised);
  el.denoise.classList.toggle("is-on", clip.denoised);
  el.denoise.setAttribute("aria-pressed", clip.denoised ? "true" : "false");
}
function renderSpeakerInspector() {
  const clip=getActiveClip(), speakers=listSpeakers(clip?.words || []), job=clip && speakerJobs.get(clip.id);
  document.querySelector('#speaker-target').textContent=clip ? `「${clip.name}」 · ${speakers.length ? speakers.length+' 位说话人' : '尚无说话人标识'}` : '先选择一个片段';
  const button=document.querySelector('#btn-speakers');
  button.disabled=!clip;
  button.textContent=job ? '取消识别' : speakers.length ? '重新识别说话人' : '识别说话人';
  button.title='将当前片段原音发送到已配置的转写服务，仅更新说话人标识';
  document.querySelector('#speaker-status').textContent=clip && speakerMessages.get(clip.id) || (speakers.length ? '点击文稿中的说话人标签，可在这里改名。' : '新导入录音会自动区分；已有录音可点击识别。');
  const key=JSON.stringify([clip?.id,speakers,!!job]);
  if(key===speakerPanelKey)return;
  speakerPanelKey=key;
  const roster=document.querySelector('#speaker-list'); roster.replaceChildren();
  for(const [i,speaker] of speakers.entries()){
    const row=document.createElement('label'); row.className='speaker-name-row';
    const number=document.createElement('span'); number.className='speaker-number'; number.textContent=String(i+1).padStart(2,'0');
    const input=document.createElement('input'); input.type='text'; input.value=speaker.name; input.maxLength=40; input.dataset.speakerId=speaker.id;
    input.setAttribute('aria-label',`说话人 ${i+1} 姓名`); input.title='修改当前片段中的显示姓名'; input.disabled=!!job;
    const commitName=()=>{
      const current=project?.clips.find(c=>c.id===clip.id);
      if(!current || speakerJobs.has(current.id))return;
      const name=input.value.trim(), existing=current.words.find(w=>w.speakerId===speaker.id)?.speakerName;
      if(!name){input.value=existing || speaker.name;return;}
      if(name===existing)return;
      pushUndo(current);
      for(const w of current.words)if(w.speakerId===speaker.id)w.speakerName=name;
      renderTranscript(); scheduleDraftSave(); renderSpeakerInspector(); syncChrome();
    };
    input.addEventListener('change',commitName);
    input.addEventListener('blur',commitName);
    input.addEventListener('keydown',ev=>{if(ev.key==='Enter'){ev.preventDefault();commitName();input.blur();}});
    row.append(number,input); roster.append(row);
  }
}
async function recognizeClipSpeakers() {
  if(!draftBootReady || returningHome){toast('正在恢复或保存工程，请稍候');return;}
  const clip=getActiveClip(); if(!clip)return;
  if(speakerJobs.has(clip.id)){speakerJobs.get(clip.id).abort();return;}
  const controller=new AbortController(); speakerJobs.set(clip.id,controller);
  speakerMessages.set(clip.id,'准备原音…'); renderSpeakerInspector();
  const originalAudio=clip.cleanBuffer, structure=JSON.stringify(clip.words.map(w=>[w.id,w.text]));
  try {
    const blob=clip.sourceBlob && !clip.bufferDirty ? clip.sourceBlob : await exportEditedWav([{buffer:originalAudio,ranges:[{start:0,end:clip.duration}]}],1);
    controller.signal.throwIfAborted();
    const file=new File([blob],clip.sourceBlob && !clip.bufferDirty ? clip.name : 'speakers.wav',{type:blob.type});
    const result=await transcribeViaProxy(file,{signal:controller.signal,onProgress:p=>{
      speakerMessages.set(clip.id,`识别说话人 ${Math.round(p.percent)}%…`); renderSpeakerInspector();
    }});
    controller.signal.throwIfAborted();
    if(!project?.clips.includes(clip) || clip.cleanBuffer!==originalAudio || structure!==JSON.stringify(clip.words.map(w=>[w.id,w.text])))throw Error('识别期间片段内容有变动，请重试；已保留你的编辑');
    const labelled=applySpeakerLabels(clip.words,result.words,`${clip.id}:${crypto.randomUUID()}`);
    if(!labelled.some(w=>w.speakerId))throw Error('转写服务未返回可匹配的说话人信息，原标识和剪辑已保留');
    // Match display names by word overlap; provider numbering can change on reruns.
    const oldNames=new Map(listSpeakers(clip.words).map(s=>[s.id,s.name]));
    const matches=new Map();
    labelled.forEach((w,i)=>{if(w.speakerId && clip.words[i].speakerId){const counts=matches.get(w.speakerId)||new Map();const old=clip.words[i].speakerId;counts.set(old,(counts.get(old)||0)+1);matches.set(w.speakerId,counts);}});
    const names=new Map();
    for(const [id,counts] of matches){const best=[...counts].sort((a,b)=>b[1]-a[1]);const total=[...counts.values()].reduce((a,b)=>a+b,0);if(best[0]?.[1]>total*.7)names.set(id,oldNames.get(best[0][0]));}
    for(const w of labelled)if(names.get(w.speakerId) && !/^说话人 \d+$/.test(names.get(w.speakerId)))w.speakerName=names.get(w.speakerId);
    pushUndo(clip); clip.words=labelled;
    renderTranscript(); syncChrome(); scheduleDraftSave();
    const saved=await flushDraftSave({toastFail:true});
    speakerMessages.set(clip.id,`已标识 ${listSpeakers(labelled).length} 位说话人 · ${saved?'已自动保存':'保存失败，请重试'}`);
    toast(speakerMessages.get(clip.id),5000);
  } catch(error) {
    const message=error?.name==='AbortError' ? '已取消，原标识和剪辑保留' : error?.message || '识别失败，请重试';
    if(project?.clips.includes(clip)){speakerMessages.set(clip.id,message); toast(message,6000);}
  } finally { if(speakerJobs.get(clip.id)===controller)speakerJobs.delete(clip.id); renderSpeakerInspector(); }
}
document.querySelector('#btn-speakers').addEventListener('click',()=>void recognizeClipSpeakers());
function syncBeautifyButton() {
  const clip = getActiveClip();
  if (!clip) {
    el.beautify.textContent = "美化";
    el.beautify.classList.remove("btn-active", "is-on");
    el.beautify.setAttribute("aria-pressed", "false");
    return;
  }
  el.beautify.textContent = clip.beautified ? "美化·开" : "美化";
  el.beautify.classList.toggle("btn-active", clip.beautified);
  el.beautify.classList.toggle("is-on", clip.beautified);
  el.beautify.setAttribute("aria-pressed", clip.beautified ? "true" : "false");
}
const PUNCT_RE = /^[，。！？、；：…—,.!?;:“”‘’]$/;
let selectedMusicCoverage = null;
function buildMusicDecor() {
  selectedMusicCoverage = null;
  const startsByWord = new Map();
  const bedUnderWordIds = new Set();
  if (!project?.music?.length) return { startsByWord, bedUnderWordIds };
  for (const clip of project.clips) ensureAudioOrder(clip);
  const scheduleClips = project.clips.map((c) => ({
    id: c.id,
    buffer: c.buffer,
    ranges: c.ranges,
    words: c.words,
    gainDb: c.gainDb ?? 0
  }));
  const mix = buildMixSchedule(scheduleClips,project.music);
  const timedWords = mixedWords(scheduleClips,mix);
  const pushStart = (wordId, m) => {
    const list = startsByWord.get(wordId) ?? [];
    list.push(m);
    startsByWord.set(wordId, list);
  };
  for (const m of project.music) {
    const clip = project.clips.find((c) => c.id === m.clipId);
    if (!clip) continue;
    let anchorWord = null;
    if (m.wordId) {
      anchorWord = clip.words.find((w) => w.id === m.wordId && !w.deleted) ?? null;
    }
    if (!anchorWord) {
      let best = null;
      let bestDist = Infinity;
      for (const w of clip.words) {
        if (w.deleted) continue;
        for (const edge of [w.start, w.end]) {
          const d = Math.abs(m.originalTime - edge);
          if (d < bestDist) {
            bestDist = d;
            best = w;
          }
        }
      }
      anchorWord = best;
    }
    if (anchorWord) pushStart(anchorWord.id, m);
    const coverage = musicCoverage(m.id,timedWords,mix,engine.getPlaybackRate());
    if(m.id===activeMusicId) selectedMusicCoverage=coverage;
    if(m.kind==='bed'&&coverage) for(const id of coverage.covered) bedUnderWordIds.add(id);
  }
  return { startsByWord, bedUnderWordIds };
}
function makeMusicChip(m) {
  const chip = document.createElement("span");
  chip.className = "music-chip" + (m.kind === "bed" ? " music-chip-bed" : " music-chip-stinger") + (m.id === activeMusicId ? " active" : "");
  chip.dataset.musicId = m.id;
  chip.contentEditable = "false";
  chip.draggable = false;
  chip.tabIndex = 0;
  chip.setAttribute("role","button");
  const short = m.name.length > 8 ? m.name.slice(0, 7) + "…" : m.name;
  chip.textContent = `${m.kind === "bed" ? "♫ 背景" : "✦ 过场"} · ${short} · ${resolveMusicRegion(m).duration.toFixed(1)}s${m.kind==="bed"&&m.leadInSec>0?` · 先行 ${m.leadInSec}s`:""} ⠿`;
  const region = resolveMusicRegion(m);
  chip.title = `${m.kind === "bed" ? "背景" : "过场"}「${m.name}」· ${m.gainDb >= 0 ? "+" : ""}${m.gainDb} dB · 素材 ${region.inPoint.toFixed(1)}–${region.outPoint.toFixed(1)}s（${region.duration.toFixed(1)}s）· 点击选中`;
  return chip;
}
function groupUtterances(words) { return groupSpeakerUtterances(words); }

function appendWordSpan(parent, clip, w, startsByWord, bedUnderWordIds) {
  if (!w.deleted) {
    const starts = startsByWord.get(w.id);
    if (starts) {
      for (const m of starts.filter(m => musicAnchorSide(m, clip.words) === "before")) {
        parent.appendChild(makeMusicChip(m));
      }
    }
  }
  const span = document.createElement("span");
  span.className = "word" + (w.deleted ? " deleted" : "") + (PUNCT_RE.test(w.text) ? " punct" : "") + (w.breakAfter ? " utterance-end" : "");
  if (w.id === activeWordId && !w.deleted) {
    span.classList.add("active");
    if (pasteSide === "before") span.classList.add("paste-before");
  }
  if (!w.deleted && dupFlaggedIds.has(w.id)) {
    span.classList.add("dup-flag");
    const reason = dupFlagReasons.get(w.id);
    if (reason) span.dataset.dupReason = reason;
  }
  if (!w.deleted && bedUnderWordIds.has(w.id)) span.classList.add("word-bed-under");
  const startsHere = startsByWord.get(w.id);
  if (!w.deleted && startsHere?.some((m) => m.kind === "bed")) {
    span.classList.add("word-bed-start");
  }
  if (!w.deleted && startsHere?.some((m) => m.kind === "stinger")) {
    span.classList.add("word-stinger-start");
  }
  if(!w.deleted&&selectedMusicCoverage?.covered.has(w.id))span.classList.add('word-music-selected');
  if(!w.deleted&&selectedMusicCoverage?.word?.id===w.id){
    span.classList.add('word-music-end');
    span.dataset.musicEnd=selectedMusicCoverage.side==='before'?'♫ 结束于此前':selectedMusicCoverage.side==='after'?'♫ 至此结束':'♫ 在此字内结束';
  }
  span.dataset.id = w.id;
  span.dataset.clipId = clip.id;
  span.textContent = w.text;
  // Transcript underlines are reserved for AI duplicate suggestions.
  // Timing provenance stays available in the word waveform panel and tooltip.
  const dupReason = !w.deleted ? dupFlagReasons.get(w.id) : void 0;
  span.title = w.deleted
    ? `${w.roughCutReason ? "初剪："+w.roughCutReason+" · " : ""}已删除 · 选中后可点「复原」`
    : dupReason
      ? `疑似重录：${dupReason} · 拖选后可删除`
      : `${clip.name} · ${w.start.toFixed(2)}s – ${w.end.toFixed(2)}s · 单击查看字音轨 · Delete 删除`;
  if (!!w.alignmentSource && !w.manualBoundary) span.title += " · 本机声学对齐";
  parent.appendChild(span);
  if (!w.deleted) for (const m of startsByWord.get(w.id) ?? []) {
    if (musicAnchorSide(m, clip.words) === "after") parent.appendChild(makeMusicChip(m));
  }
}
function renderTranscript() {
  dupFlaggedIds=new Set();dupFlagReasons=new Map();
  for(const c of project?.clips??[])for(const w of c.words)if(!w.deleted&&w.duplicateReason){dupFlaggedIds.add(w.id);dupFlagReasons.set(w.id,w.duplicateReason);}
  if (!project || project.clips.length === 0) {
    el.transcript.replaceChildren();
    return;
  }
  const { startsByWord, bedUnderWordIds } = buildMusicDecor();
  const frag = document.createDocumentFragment();
  const multiClip = project.clips.length > 1;
  const pauseEntries=[];
  project.clips.forEach((clip, clipIdx) => {
    if (multiClip) {
      const label = document.createElement("span");
      label.className = "clip-sep" + (clipIdx === 0 ? " clip-sep-first" : "");
      label.contentEditable = "false";
      label.textContent = clipIdx === 0 ? `【${clip.name}】` : ` ·【${clip.name}】 `;
      frag.appendChild(label);
    }
    const hasSpeakers = clip.words.some(w => !!w.speakerId);
    let leadingCaret;
    const firstAlive = clip.words.find((w) => !w.deleted);
    if (firstAlive) {
      const caret = document.createElement("span");
      caret.className = "paste-caret" + (activeWordId === firstAlive.id && pasteSide === "before" ? " active" : "");
      caret.contentEditable = "false";
      caret.dataset.clipId = clip.id;
      caret.dataset.wordId = firstAlive.id;
      caret.setAttribute("role", "button");
      caret.setAttribute("aria-label", "粘贴到开头（插在第一个字前面）");
      caret.title = "从本段开头播放（包含保留停顿）；粘贴插到第一个字前";
      caret.tabIndex = 0;
      caret.textContent = "|";
      if(hasSpeakers)leadingCaret=caret;else frag.appendChild(caret);
    }
    const marksAfter = new Map(), marksBefore = new Map();
    for (const group of clipPauseGroups(clip)) {
      pauseEntries.push({clip,group});
      if (!group.anchorId) {
        if (group.beforeId) marksBefore.set(group.beforeId,group);
        else frag.appendChild(makePauseGroupMark(clip.id,group));
        continue;
      }
      const list = marksAfter.get(group.anchorId) ?? [];
      list.push(group); marksAfter.set(group.anchorId, list);
    }
    const utterances = groupUtterances(clip.words);
    let previousSpeaker;
    utterances.forEach((uttWords, uIdx) => {
      const first = uttWords[0];
      if (hasSpeakers && (uIdx === 0 || first.speakerId !== previousSpeaker)) {
        const label = document.createElement(first.speakerId ? 'button' : 'span');
        if (first.speakerId) { label.type='button'; label.dataset.speakerId=first.speakerId; }
        label.className='speaker-label' + (!first.speakerId ? ' is-unknown' : '');
        label.contentEditable='false'; label.dataset.clipId=clip.id;
        label.textContent=first.speakerName || UNKNOWN_SPEAKER;
        if (first.speakerId) label.title='点击修改本片段中的说话人姓名';
        frag.appendChild(label);
      }
      previousSpeaker=first.speakerId;
      if(uIdx===0 && leadingCaret)frag.appendChild(leadingCaret);
      for (let wi = 0; wi < uttWords.length; wi++) {
        const w = uttWords[wi];
        if (marksBefore.has(w.id)) frag.appendChild(makePauseGroupMark(clip.id,marksBefore.get(w.id)));
        appendWordSpan(frag, clip, w, startsByWord, bedUnderWordIds);
        for (const pause of marksAfter.get(w.id) ?? []) frag.appendChild(makePauseGroupMark(clip.id, pause));
      }
      const hasMoreInClip = uIdx < utterances.length - 1;
      const hasMoreClips = clipIdx < project.clips.length - 1;
      if (hasMoreInClip || hasMoreClips) {
        const sep = document.createElement("span");
        sep.className = "utt-dot";
        sep.contentEditable = "false";
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = " · ";
        frag.appendChild(sep);
      }
    });

  });
  el.transcript.replaceChildren(frag);
  updatePauseSummary(pauseEntries);
}
function clipPauses(clip, withBreaths=true) {
  ensureAudioOrder(clip);
  return analyzeClipPauses(clip,withBreaths).pauses;
}
const pauseCutCache=new WeakMap();

function groupBulkCuts(group, clip) {
  const kept=bulkPauseParts(group,thresholdSec).sort((a,b)=>a.start-b.start);
  if(!kept.length)return [];
  let cuts=pauseCutCache.get(group);
  if(!cuts){cuts=pauseDeletionCuts(clip.words,kept).flatMap(p=>clip.ranges.map(r=>({start:Math.max(p.start,r.start),end:Math.min(p.end,r.end)})).filter(r=>r.end>r.start+1e-7));pauseCutCache.set(group,cuts);}
  return cuts;
}
function updatePauseSummary(cachedEntries) {
  const entries=cachedEntries??(project?.clips??[]).flatMap(clip=>clipPauseGroups(clip).map(group=>({clip,group})));
  const groups=entries.filter(({group})=>pauseGroupDisplay(group)?.cleared===false);
  const cuts=entries.map(({clip,group})=>groupBulkCuts(group,clip)).filter(c=>c.length);
  const saved=cuts.flat().reduce((sum,p)=>sum+p.end-p.start,0);
  document.querySelector("#pause-summary").textContent=`${groups.length} 处停顿 · 可删除 ${cuts.length} 处 / ${saved.toFixed(1)}s`;
}
function clipPauseGroups(clip) {
  ensureAudioOrder(clip);
  // Group labels without expanding their owned intervals. In particular, a
  // neighbouring deleted fragment must never enlarge a manually trimmed pause.
  return analyzeClipPauses(clip).groups;
}
function makePauseGroupMark(clipId, group) {
  const wrap = document.createElement("span");
  wrap.className = "pause-group"; wrap.contentEditable = "false";
  const display = pauseGroupDisplay(group);
  if (!display) return wrap;
  const {duration,cleared:restore} = display;
  const mark = document.createElement("button"); mark.type = "button";
  mark.className = restore ? "mark-pause-cleared" : "mark-pause";
  mark.dataset.clipId = clipId; mark.dataset.pauseId = group.id;
  mark.textContent = restore ? "↶" : `Ⅱ ${duration.toFixed(2)}s`;
  mark.title = restore ? `点击复原整处停顿 · 累计已删除 ${duration.toFixed(2)}s` : `停顿 ${duration.toFixed(2)}s · 点击删除，不受批量阈值限制`;
  mark.setAttribute("aria-label",mark.title); wrap.appendChild(mark);
  const edit = document.createElement("button");edit.type="button";edit.className="pause-edit";
  edit.textContent="∿";edit.title=restore ? "调整停顿切口" : "调整停顿边界";edit.setAttribute("aria-label",edit.title);
  edit.dataset.clipId=clipId;edit.dataset.pauseId=group.id;edit.dataset.cleared=String(restore);wrap.appendChild(edit);
  return wrap;
}
function removeSinglePause(clipId, pauseId) {
  const clip = project?.clips.find(c => c.id === clipId);
  const group = clip && clipPauseGroups(clip).find(g => g.id === pauseId);
  if (!group) return;
  pushUndo(clip); clip.clearedPauses ??= [];
  let removed = 0;
  for (const part of group.parts.filter(p => !p.cleared)) {
    const cut = singlePauseCut(part); removed += cut.end-cut.start;
    clip.clearedPauses.push({id:crypto.randomUUID(),...cut});
    clip.ranges = removeRange(clip.ranges,cut.start,cut.end);
  }
  activeClipId = clipId;
  syncEngineFromProject(); renderTrack(); renderTranscript(); syncChrome(); scheduleDraftSave();
  toast(`已删除这段停顿 ${removed.toFixed(2)}s · 可点击复原`);
}
function renderTrack() {
  el.track.innerHTML = "";
  const clips = project?.clips ?? [];
  if (clips.length === 0 && asrJobs.length === 0) {
    syncTrackPanelVisibility();
    return;
  }
  // Completed clips (vertical stack — B4 progress rows share this rail)
  clips.forEach((clip, idx) => {
    const block = document.createElement("div");
    block.className = "track-block" + (clip.id === activeClipId ? " active" : "");
    block.draggable = true;
    block.dataset.clipId = clip.id;
    block.setAttribute("role", "listitem");
    const editDur = editedDuration(clip.ranges);
    block.innerHTML = `
      <span class="track-grip" title="拖拽调序" aria-hidden="true">⋮⋮</span>
      <span class="track-idx">${idx + 1}</span>
      <span class="track-main">
        <span class="track-name">${escapeHtml(clip.name)}</span>
        <span class="track-meta">${fmt(editDur)}${clip.denoised ? " · 降噪" : ""}${clip.beautified ? " · 美化" : ""}</span>
      </span>
      <span class="track-actions">
        <button type="button" class="btn-icon" data-act="up" title="前移" ${idx === 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="btn-icon" data-act="down" title="后移" ${idx === clips.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" class="btn-icon" data-act="remove" title="移除">×</button>
      </span>
    `;
    el.track.appendChild(block);
  });
  // In-progress / failed ASR jobs (REDESIGN v1.8 §5.1)
  for (const job of asrJobs) {
    const block = document.createElement("div");
    block.className =
      "track-block track-block-job" +
      (job.status === "error" ? " is-error" : "") +
      (job.status === "queued" ? " is-queued" : "") +
      (job.status === "running" ? " is-running" : "");
    block.draggable = false;
    block.dataset.jobId = job.id;
    block.setAttribute("role", "listitem");
    const pct = Math.max(0, Math.min(100, Math.round(job.progress || 0)));
    let statusHtml = "";
    if (job.status === "queued") {
      statusHtml = `<span class="job-status">排队中</span>
        <div class="job-progress job-progress-indeterminate" aria-hidden="true"><i></i></div>`;
    } else if (job.status === "running") {
      statusHtml = `<span class="job-status">转写中 ${pct}%</span>
        <div class="job-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
          <span class="job-progress-bar" style="width:${pct}%"></span>
        </div>`;
    } else {
      statusHtml = `<span class="job-status job-status-error">${escapeHtml(job.error || "转写失败")}</span>
        <span class="track-actions track-actions-job">
          <button type="button" class="btn btn-sm job-retry" data-act="retry-job" title="重试">重试</button>
          <button type="button" class="btn-icon" data-act="dismiss-job" title="关闭">×</button>
        </span>`;
    }
    const title =
      job.status === "running"
        ? "转写中…"
        : job.status === "queued"
          ? job.name
          : job.name;
    block.innerHTML = `
      <span class="track-name">${escapeHtml(title)}</span>
      ${statusHtml}
    `;
    el.track.appendChild(block);
  }
  syncTrackPanelVisibility();
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function setActiveHighlight(id, side = "after") {
  activeWordId = id;
  pasteSide = id ? side : "after";
  for (const node2 of el.transcript.querySelectorAll(".word.active, .word.paste-before")) {
    node2.classList.remove("active", "paste-before");
  }
  for (const node2 of el.transcript.querySelectorAll(".paste-caret.active")) {
    node2.classList.remove("active");
  }
  if (!id) return;
  const node = el.transcript.querySelector(`.word[data-id="${CSS.escape(id)}"]`);
  node?.classList.add("active");
  if (pasteSide === "before") {
    node?.classList.add("paste-before");
    const clipId = node?.dataset.clipId;
    if (clipId) {
      const caret = el.transcript.querySelector(
        `.paste-caret[data-clip-id="${CSS.escape(clipId)}"]`
      );
      const first = firstVisibleWord(clipId);
      if (first && first.id === id) caret?.classList.add("active");
    }
  }
}
function firstVisibleWord(clipId) {
  const clip = project?.clips.find((c) => c.id === clipId);
  if (!clip) return null;
  return clip.words.find((w) => !w.deleted) ?? null;
}
function setReadingHighlight(id) {
  if (id === readingWordId && (!id || el.transcript.querySelector(".word.is-reading"))) return;
  for (const node of el.transcript.querySelectorAll(".word.is-reading")) {
    node.classList.remove("is-reading"); node.removeAttribute("aria-current");
  }
  readingWordId = id;
  const node = id && el.transcript.querySelector(`.word[data-id="${CSS.escape(id)}"]`);
  if (!node) return;
  node.classList.add("is-reading"); node.setAttribute("aria-current", "true");
  const r = node.getBoundingClientRect(), box = el.transcript.getBoundingClientRect();
  if (r.top < box.top + 16 || r.bottom > box.bottom - 16) node.scrollIntoView({block:"nearest"});
}
function setActiveFromPlayhead(clipIndex, original) {
  if (!project || clipIndex == null || original == null) {
    setReadingHighlight(null);
    if (activeWordId) setActiveHighlight(null);
    el.statHead.textContent = fmt(engine.getOutputTime());
    return;
  }
  const clip = project.clips[clipIndex];
  if (!clip) return;
  if (clip.id !== activeClipId) {
    activeClipId = clip.id;
    renderTrack();
    syncDenoiseButton();
    syncBeautifyButton();
  }
  const w = wordAtOriginal(clip.words, original);
  const id = w?.id ?? null;
  setReadingHighlight(engine.isPlaying() ? id : null);
  if (id !== activeWordId || pasteSide !== "after") setActiveHighlight(id, "after");
  el.statHead.textContent = fmt(engine.getOutputTime());
}
engine.setWarnHandler((msg) => toast(msg, 4500));
engine.setHandlers({
  onTick: (_edit, clipIndex, original) => setActiveFromPlayhead(clipIndex, original),
  onEnded: () => {
    syncChrome();
    toast("播放结束");
  }
});
function syncAlignmentUi() {
  const button = document.querySelector("#btn-align-clip");
  if (!button) return;
  const clip = getActiveClip(), job = alignmentJobs.size > 0;
  button.disabled = !project?.clips.length || !!job;
  button.textContent = job ? `校准中（${alignmentJobs.size} 段）` : "校准字界";
  document.querySelector("#btn-cancel-alignment").hidden = !job;

  const aligned = clip?.words.filter(w => !!w.alignmentSource).length || 0;
  document.querySelector("#alignment-status").textContent = clip && alignmentMessages.get(clip.id) || (aligned ? `已有 ${aligned} 字声学对齐 · 保留手动字界` : "导入后自动逐字校准 · 手动字界保留");
}
function queueClipAlignment(clip) {
  if (alignmentJobs.has(clip.id)) return;
  const controller = new AbortController();
  alignmentJobs.set(clip.id, controller);
  alignmentMessages.set(clip.id, "等待本机对齐…"); syncAlignmentUi();
  const task = async () => {
    if (controller.signal.aborted || !project?.clips.includes(clip)) return;
    ensureAudioOrder(clip);
    const before = alignmentFingerprint(clip), audio = clip.cleanBuffer;
    const inputVersion = boundaryEditVersions.get(clip.id) || 0;
    try {
      const proposals = await requestForcedAlignment(clip, controller.signal, (done, total) => {
        alignmentMessages.set(clip.id, `自动逐字校准 ${done}/${total} 段 · 保留手动字界`); syncAlignmentUi();
      });
      controller.signal.throwIfAborted();
      if (!project?.clips.includes(clip) || clip.cleanBuffer !== audio || (boundaryEditVersions.get(clip.id) || 0) !== inputVersion || alignmentFingerprint(clip) !== before) throw new Error("对齐期间片段有编辑，已保留你的修改；请重新对齐");
      const result = applyForcedAlignment(clip, proposals);
      if (!result.aligned) throw new Error("未获得可用的新字界，已保留原字界与手动调整");
      pushUndo(clip);
      clip.words = result.words; clip.ranges = result.ranges; clip.audioOrder = result.audioOrder;
      syncEngineFromProject(); renderTranscript(); renderTrack(); syncChrome();
      if (wordRailState?.clipId === clip.id) openWordAudioRail(clip.id, wordRailState.wordId);
      scheduleDraftSave();
      const saved = await flushDraftSave({toastFail:true});
      const details = [ `${result.aligned} 字已对齐`, result.manual ? `${result.manual} 字保留手调` : "", saved ? "已保存到本机" : "保存失败，请重试" ].filter(Boolean).join(" · ");
      alignmentMessages.set(clip.id, details); toast(details, 6000);
    } catch(error) {
      const message = error?.name === "AbortError" ? "已取消，原字界保留" : error?.message || "对齐失败，原字界保留";
      alignmentMessages.set(clip.id, message); toast(message, 6000);
    }
  };
  const queued = alignmentQueue.then(task).finally(() => { alignmentJobs.delete(clip.id); syncAlignmentUi(); });
  alignmentQueue = queued.catch(() => {});
  return queued;
}
function wordsFromTranscript(data, clipId) {
  return scopeSpeakers(data.words, clipId).map((w, i) => ({
    id: `${clipId}-w${i}`,
    text: w.text,
    start: w.start,
    end: w.end,
    deleted: false,
    estimated: w.estimated,
    alignmentSource: w.alignmentSource,
    speakerId: w.speakerId,
    speakerName: w.speakerName,
    breakAfter: w.breakAfter === true
  }));
}
function refreshAfterClipsChange(opts = {}) {
  if (!project) return;
  if (!project.music) project.music = [];
  if (!activeClipId || !project.clips.some((c) => c.id === activeClipId)) {
    activeClipId = project.clips[0]?.id ?? null;
  }
  if (project.clips.length === 1) {
    project.audioName = project.clips[0].name;
  } else if (project.clips.length > 1) {
    project.audioName = `podcast-${project.clips.length}clips`;
  }
  project.music = project.music.filter(
    (m) => project.clips.some((c) => c.id === m.clipId)
  );
  syncEngineFromProject();
  renderTrack();
  renderMusicInspector();
  renderTranscript();
  syncChrome();
  if (opts.persist !== false) scheduleDraftSave();
}
async function loadDemo() {
  try {
    const [metaRes, audioRes] = await Promise.all([
      fetch("/demo/transcript.json"),
      fetch("/demo/sample.wav")
    ]);
    if (!metaRes.ok || !audioRes.ok) { toast("开源包不附带演示朗读，请从「导入音频」选择自己的录音。", 6000); return; }
    const meta = await metaRes.json();
    const buf = await audioRes.arrayBuffer();
    const audioBuf = await engine.decodeArrayBuffer(buf);
    const duration = audioBuf.duration || meta.duration;
    const id = nextClipId();
    undo.clear();
    project = {
      clips: [
        {
          id,
          name: "demo-sample",
          buffer: audioBuf,
          cleanBuffer: audioBuf,
          duration,
          words: wordsFromTranscript(meta, id).map(w => ({ ...w, estimated: !w.alignmentSource && !isPunctText(w.text) })),
          ranges: fullRange(duration),
          denoised: false,
          beautified: false,
        clearedPauses: []
        }
      ],
      gainDb: project?.gainDb ?? GAIN_DB_DEFAULT,
      speechRate: engine.getPlaybackRate(),
      audioName: "demo-sample",
      music: []
    };
    activeWordId = null;
    pasteSide = "after";
    activeClipId = id;
    dupFlaggedIds = new Set();
    dupFlagReasons = new Map();
    engine.setGain(dbToLinear(project.gainDb));
    engine.setFallbackUrl("/demo/sample.wav");
    syncGainUi(getActiveClip()?.gainDb ?? 0);
    refreshAfterClipsChange();
    toast("演示已加载 · 可点击任意字检查音轨；重新校准字界可重新校准", 5000);
    if (project.clips[0].words.some(w => w.estimated)) void queueClipAlignment(project.clips[0]);
  } catch (err) {
    console.error(err);
    toast("加载演示失败");
  }
}
function clearProject() {
  // Explicit project clear → cancel in-flight ASR (user intent).
  cancelAllAsrJobs("project-cleared");
  for (const job of alignmentJobs.values()) job.abort();
  for (const job of speakerJobs.values()) job.abort();
  speakerJobs.clear(); speakerMessages.clear();
  engine.stop();
  engine.setFallbackUrl(null);
  undo.clear();
  project = null;
  activeWordId = null;
  pasteSide = "after";
  activeClipId = null;
  activeMusicId = null;
  engine.setClips([]);
  engine.setMixSchedule(null);
  renderTrack();
  renderMusicInspector();
  renderTranscript();
  syncChrome();
  ensureImportControlsEnabled();
  dupFlaggedIds = new Set();
  dupFlagReasons = new Map();
  wordClipboard = null;
  toast("已清空");
  draftAllowClear = true;
    draftRecoveryBlocked = false;
    scheduleDraftSave();
    void flushDraftSave();
}
function ensureImportControlsEnabled() {
  // B3: never leave import controls stuck grey after failure/abort.
  // Do NOT clear the ASR watchdog here — see kickImportWatchdog / clearImportWatchdogIfIdle.
  try {
    el.upload.disabled = false;
    el.demo.disabled = false;
    el.urlBtn.disabled = false;
  } catch (e) {
    console.warn("re-enable import controls failed", e);
  }
}
function clearImportWatchdogIfIdle() {
  if (hasAsrJobs()) return;
  window.clearTimeout(importWatchdog);
  importWatchdog = 0;
}
function kickImportWatchdog() {
  // Keep armed whenever there is any queued/running/error job still in the rail.
  // Cleared only when the queue is fully idle (B3 review).
  window.clearTimeout(importWatchdog);
  if (!hasAsrJobs()) {
    importWatchdog = 0;
    return;
  }
  importWatchdog = window.setTimeout(() => {
    ensureImportControlsEnabled();
    toast("转写耗时过长，已恢复导入按钮；进行中的任务仍会在左栏显示", 4500);
    // Re-arm while jobs remain so a later hang still unlocks again.
    if (hasAsrJobs()) kickImportWatchdog();
  }, 240000);
}
function hasAsrJobs() {
  return asrJobs.length > 0;
}
function syncTrackPanelVisibility() {
  const ready = !!project && project.clips.length > 0;
  syncAlignmentUi();
  app.classList.toggle("has-project", ready);
  if (!engine.isPlaying()) setReadingHighlight(null);
  const jobs = hasAsrJobs();
  el.trackPanel.hidden = !ready && !jobs;
  el.railClipsEmpty.hidden = ready || jobs;
}
function removeAsrJob(id) {
  const i = asrJobs.findIndex((j) => j.id === id);
  if (i >= 0) asrJobs.splice(i, 1);
}
function cancelAllAsrJobs(reason) {
  for (const job of [...asrJobs]) {
    try {
      job.controller?.abort(reason || "cancelled");
    } catch {
      /* */
    }
  }
  asrJobs = [];
  asrQueueRunning = false;
  ensureImportControlsEnabled();
  clearImportWatchdogIfIdle();
  renderTrack();
  syncTrackPanelVisibility();
}
function enqueueFileAsrJobs(files) {
  const list = Array.from(files).filter(Boolean);
  if (list.length === 0) return;
  for (const file of list) {
    const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    asrJobs.push({
      id,
      name: (file.name || "audio").replace(/\.[^.]+$/, "") || "audio",
      fileName: file.name || "audio",
      status: "queued",
      progress: 0,
      error: null,
      kind: "file",
      file,
      controller: new AbortController(),
    });
  }
  setRailTab("clips");
  syncTrackPanelVisibility();
  renderTrack();
  syncChrome();
  kickImportWatchdog();
  toast(
    list.length > 1
      ? `已加入 ${list.length} 个转写任务（后台进行，可继续编辑）`
      : `已加入转写任务：${list[0].name}`,
    2800,
  );
  void pumpAsrQueue();
}
function enqueueUrlAsrJob(url) {
  const trimmed = url.trim();
  const name =
    trimmed.split("/").pop()?.split("?")[0]?.replace(/\.[^.]+$/, "") || "audio";
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  asrJobs.push({
    id,
    name,
    fileName: name,
    status: "queued",
    progress: 0,
    error: null,
    kind: "url",
    url: trimmed,
    controller: new AbortController(),
  });
  setRailTab("clips");
  syncTrackPanelVisibility();
  renderTrack();
  syncChrome();
  kickImportWatchdog();
  toast("已加入 URL 转写任务（后台进行）", 2800);
  void pumpAsrQueue();
}
async function pumpAsrQueue() {
  if (asrQueueRunning) return;
  asrQueueRunning = true;
  ensureImportControlsEnabled();
  kickImportWatchdog();
  try {
    while (true) {
      const job = asrJobs.find((j) => j.status === "queued");
      if (!job) break;
      job.status = "running";
      job.progress = 3;
      job.error = null;
      renderTrack();
      syncTrackPanelVisibility();
      try {
        await runAsrJob(job);
        removeAsrJob(job.id);
        renderTrack();
        syncTrackPanelVisibility();
        syncChrome();
      } catch (err) {
        if (job.controller?.signal?.aborted) {
          removeAsrJob(job.id);
          renderTrack();
          syncTrackPanelVisibility();
          continue;
        }
        const msg = err instanceof Error ? err.message : "转写失败";
        console.error(err);
        job.status = "error";
        job.error = msg;
        job.progress = 0;
        renderTrack();
        syncTrackPanelVisibility();
        toast(msg, 4500);
      }
    }
  } finally {
    asrQueueRunning = false;
    ensureImportControlsEnabled();
    if (hasAsrJobs()) kickImportWatchdog();
    else clearImportWatchdogIfIdle();
    syncTrackPanelVisibility();
    syncChrome();
  }
}
async function runAsrJob(job) {
  const signal = job.controller.signal;
  const onProgress = (info) => {
    if (!asrJobs.some((j) => j.id === job.id)) return;
    job.progress = Math.max(job.progress, Math.min(99, info.percent || 0));
    job.status = "running";
    renderTrack();
  };

  if (job.kind === "url") {
    const asr = await transcribeViaUrl(job.url, {
      signal,
      onProgress,
    });
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    let audioBuf = null;
    let duration = asr.duration;
    try {
      const audioRes = await fetch(job.url, { signal });
      if (audioRes.ok) {
        const buf = await audioRes.arrayBuffer();
        job._sourceBuf = buf;
        job._sourceMime = audioRes.headers.get("content-type") || "audio/mpeg";
        audioBuf = await engine.decodeArrayBuffer(buf.slice(0));
        duration = audioBuf.duration;
      } else {
        toast("转写成功，但浏览器无法拉取该 URL 播放（可再上传本地文件对照）", 4500);
      }
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      toast("转写成功；播放需自行上传同文件（URL 跨域限制）", 4500);
    }
    if (!audioBuf) {
      const ctx = new OfflineAudioContext(
        1,
        Math.max(1, Math.floor(duration * 44100)),
        44100,
      );
      audioBuf = ctx.createBuffer(
        1,
        Math.max(1, Math.floor(duration * 44100)),
        44100,
      );
    }
    const urlSource =
      job._sourceBuf
        ? new Blob([job._sourceBuf], { type: job._sourceMime || "audio/mpeg" })
        : null;
    await commitAsrClip({
      name: job.name,
      audioBuf,
      duration,
      asr,
      fallbackFile: null,
      sourceBlob: urlSource,
    });
    toast(`转写成功：${asr.words.length} 字，已加入轨道`, 3200);
    return;
  }

  // file
  const file = job.file;
  job.progress = Math.max(job.progress, 5);
  renderTrack();
  const buf = await file.arrayBuffer();
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  // Keep compressed bytes for IDB draft (PCM snapshots are too large for long podcasts).
  const sourceBlob = new Blob([buf], {
    type: file.type || "application/octet-stream",
  });
  const audioBuf = await engine.decodeArrayBuffer(buf);
  const duration = audioBuf.duration;
  job.progress = Math.max(job.progress, 8);
  renderTrack();

  const asr = await transcribeViaProxy(file, {
    signal,
    onProgress,
  });
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  const endSet = new Set(asr.utteranceEnds ?? []);
  const id = nextClipId();
  const words = wordsFromTranscript({words:asr.words.map((w,i)=>({...w,breakAfter:w.breakAfter || endSet.has(i)}))},id);
  await commitAsrClip({
    name: job.name,
    audioBuf,
    duration,
    asr,
    words,
    clipId: id,
    fallbackFile: file,
    sourceBlob,
  });
  toast(`已添加：${file.name}`, 2800);
}
async function commitAsrClip(opts) {
  const {
    name,
    audioBuf,
    duration,
    asr,
    words: presetWords,
    clipId: presetId,
    fallbackFile,
  } = opts;
  const id = presetId || nextClipId();
  let words = presetWords;
  if (!words && asr) {
    const endSet = new Set(asr.utteranceEnds ?? []);
    words = wordsFromTranscript({words:asr.words.map((w,i)=>({...w,breakAfter:w.breakAfter || endSet.has(i)}))},id);
  }
  words = characterWords(words || []);
  // Conservative local cleanup only. Acoustic forced alignment runs after the first durable save.
  let refineNote = "";
  try {
    const stats = refineWordBoundariesFromBuffer(words, audioBuf, {
      searchSec: 0.03,
      frameMs: 10,
      minDurSec: 0.04,
    });
    if (stats.adjusted > 0) {
      refineNote = ` · 边界细化 ${stats.adjusted}字 (~${stats.meanAbsShiftMs.toFixed(0)}ms)`;
    }
  } catch (err) {
    console.warn("refineWordBoundaries failed", err);
  }
  const sourceBlob = opts.sourceBlob || fallbackFile || null;
  const clip = {
    id,
    name,
    buffer: audioBuf,
    cleanBuffer: audioBuf,
    duration: duration || (words.at(-1)?.end ?? 0),
    words,
    ranges: fullRange(duration || (words.at(-1)?.end ?? 0)),
    denoised: false,
    beautified: false,
    clearedPauses: [],
    sourceBlob: sourceBlob || undefined,
    sourceMime: sourceBlob
      ? sourceBlob.type || (fallbackFile && fallbackFile.type) || "application/octet-stream"
      : undefined,
    bufferDirty: false,
  };
  const proj = ensureProject();
  proj.clips.push(clip);
  activeClipId = id;
  activeWordId = null;
  pasteSide = "after";
  if (proj.clips.length === 1 && clip.sourceBlob) {
    try {
      engine.setFallbackUrl(URL.createObjectURL(clip.sourceBlob));
    } catch {
      /* */
    }
  } else if (proj.clips.length > 1) {
    engine.setFallbackUrl(null);
  }
  refreshAfterClipsChange();
  ensureDraftHeartbeat();
  if (refineNote) {
    toast("已完成局部字界检查" + refineNote, 3200);
  }
  // Critical: await IDB before ASR job finishes so refresh cannot race.
  const saved = await persistDraftCritical();
  if (!saved) {
    toast("警告：本段音频草稿未写入磁盘级缓存，刷新可能丢失", 5500);
  }
  if (sourceBlob) void queueClipAlignment(clip);
}
async function loadAudioFiles(files) {
  // B3/B4: enqueue background jobs; do NOT disable import for the whole run.
  ensureImportControlsEnabled();
  enqueueFileAsrJobs(files);
}
async function loadFromPublicUrl(url) {
  let parsed;
  try { parsed = parseAudioUrl(url); }
  catch (error) { toast(error.message, 4500); ensureImportControlsEnabled(); return; }
  ensureImportControlsEnabled();
  enqueueUrlAsrJob(parsed.href);
}
function findClipByWordId(wordId) {
  if (!project) return null;
  for (const c of project.clips) {
    if (c.words.some((w) => w.id === wordId)) return c;
  }
  return null;
}
function clampRailSel() {
  if (!wordRailState) return;
  const s = wordRailState;
  s.selStart = Math.max(s.viewStart, Math.min(s.selStart, s.selEnd - 0.02));
  s.selEnd = Math.min(s.viewEnd, Math.max(s.selEnd, s.selStart + 0.02));
}
function secToRailX(sec) {
  if (!wordRailState) return 0;
  const s = wordRailState;
  const w = el.wordRailWrap.clientWidth || 240;
  const span = Math.max(1e-3, s.viewEnd - s.viewStart);
  return ((sec - s.viewStart) / span) * w;
}
function railXToSec(x) {
  if (!wordRailState) return 0;
  const s = wordRailState;
  const w = el.wordRailWrap.clientWidth || 240;
  const span = Math.max(1e-3, s.viewEnd - s.viewStart);
  return s.viewStart + (Math.max(0, Math.min(w, x)) / w) * span;
}
function paintWordRailWave() {
  if (!wordRailState || !project) return;
  const clip = project.clips.find((c) => c.id === wordRailState.clipId);
  if (!clip?.buffer) return;
  const canvas = el.wordRailCanvas;
  const wrapW = el.wordRailWrap.clientWidth || 240;
  const dpr = window.devicePixelRatio || 1;
  const cssH = 84;
  canvas.width = Math.floor(wrapW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.width = wrapW + "px";
  canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const palette=getComputedStyle(document.documentElement);
  const tone=(name)=>palette.getPropertyValue(name).trim();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, wrapW, cssH);
  ctx.fillStyle = tone("--wave-bg");
  ctx.fillRect(0, 0, wrapW, cssH);
  const buf = clip.cleanBuffer || clip.buffer;
  const channels = Array.from({length:buf.numberOfChannels}, (_,c) => buf.getChannelData(c));
  const ch = channels[0];
  const rate = buf.sampleRate;
  const s = wordRailState;
  const i0 = Math.max(0, Math.floor(s.viewStart * rate));
  const i1 = Math.min(ch.length, Math.ceil(s.viewEnd * rate));
  const buckets = Math.max(48, Math.floor(wrapW));
  const span = Math.max(1, i1 - i0);
  ctx.fillStyle = tone("--wave-ink");
  const mid = 54;
  for (let b = 0; b < buckets; b++) {
    const a = i0 + Math.floor((b / buckets) * span);
    const c = i0 + Math.floor(((b + 1) / buckets) * span);
    let peak = 0;
    for (let i = a; i < c; i++) for (const channel of channels) peak = Math.max(peak, Math.abs(channel[i] || 0));
    const h = Math.max(1, peak * 52);
    const x = (b / buckets) * wrapW;
    ctx.fillRect(x, mid - h / 2, Math.max(1, wrapW / buckets - 0.5), h);
  }
  // focus band (original word)
  const fx0 = secToRailX(s.focusStart);
  const fx1 = secToRailX(s.focusEnd);
  ctx.fillStyle = tone("--wave-focus");
  ctx.fillRect(fx0, 0, Math.max(1, fx1 - fx0), cssH);
  // Put source word labels directly above their waveform spans.
  ctx.font = "11px system-ui"; ctx.textAlign = "center";
  for (const word of clip.words) {
    if (isPunctText(word.text) || word.end <= s.viewStart || word.start >= s.viewEnd) continue;
    const left = Math.max(0, secToRailX(word.start)), right = Math.min(wrapW, secToRailX(word.end));
    ctx.strokeStyle = tone(word.id === s.wordId ? "--accent" : "--wave-grid");
    ctx.beginPath(); ctx.moveTo(left, 22); ctx.lineTo(left, cssH); ctx.stroke();
    ctx.fillStyle = tone(word.deleted ? "--word-deleted" : word.id === s.wordId ? "--accent" : "--muted");
    if (right-left > 8) ctx.fillText(word.text, (left+right)/2, 15, Math.max(8,right-left-2));
  }
  syncWordRailChrome();
}
function syncWordRailChrome() {
  if (!wordRailState) return;
  clampRailSel();
  const s = wordRailState;
  const x0 = secToRailX(s.selStart);
  const x1 = secToRailX(s.selEnd);
  el.wordRailSel.hidden = false;
  el.wordRailSel.style.left = x0 + "px";
  el.wordRailSel.style.width = Math.max(2, x1 - x0) + "px";
  el.wordRailHLeft.style.left = Math.max(0, x0 - 4) + "px";
  el.wordRailHRight.style.left = Math.max(0, x1 - 4) + "px";
  el.wordRailT0.textContent = s.viewStart.toFixed(2) + "s";
  el.wordRailT1.textContent = s.viewEnd.toFixed(2) + "s";
  document.querySelector("#boundary-start").value = String(Number(s.selStart.toFixed(6)));
  document.querySelector("#boundary-end").value = String(Number(s.selEnd.toFixed(6)));
  el.wordRailTSel.textContent =
    "选区 " + s.selStart.toFixed(2) + "–" + s.selEnd.toFixed(2) + "s";
}
function openPauseAudioRail(clipId,pauseId,cleared) {
  const clip=project?.clips.find(c=>c.id===clipId);
  const group=clip && clipPauseGroups(clip).find(g=>g.id===pauseId);
  const parts=group?.parts.filter(p=>!!p.cleared===cleared);
  if(!parts?.length) return;
  const start=Math.min(...parts.map(p=>p.start)),end=Math.max(...parts.map(p=>p.end));
  const manual = !cleared ? (clip.manualPauses??[]).filter(m=>parts.some(p=>p.id===m.id || p.id.startsWith(`${m.id}-`))) : [];
  // Preserve the original detection footprint across close/reopen. Otherwise
  // trimming twice exposes the old tail to the detector as a "new" pause.
  const sourceStart=Math.min(start,...manual.map(m=>m.sourceStart));
  const sourceEnd=Math.max(end,...manual.map(m=>m.sourceEnd));
  showPauseRail(clip,{clipId,parts,cleared,removedParts:group.parts.filter(p=>p.cleared),sourceStart,sourceEnd,manualId:manual.length===1 ? manual[0].id : undefined},start,end);
}
function showPauseRail(clip,state,start,end) {
  window.clearTimeout(boundarySaveTimer); boundarySaveTimer=0;
  activePause=state; activeClipId=clip.id; activeMusicId=null; setActiveHighlight(null);
  window.getSelection()?.removeAllRanges(); renderMusicInspector();
  const view=viewWindowAround({start,end},clip.duration,.4);
  wordRailState={clipId:clip.id,wordId:null,viewStart:view.start,viewEnd:view.end,focusStart:start,focusEnd:end,selStart:start,selEnd:end};
  document.querySelector("#word-rail").hidden=false;
  document.querySelector("#word-rail-empty").hidden=true;
  el.wordRailGroup.hidden=false;el.wordRailGroup.open=true;
  el.wordRailLabel.textContent=state.cleared ? "已删停顿 · 边界精修" : "停顿 · 边界精修";
  el.wordRailMeta.textContent=`${start.toFixed(3)}–${end.toFixed(3)}s`;
  document.querySelector("#word-boundary-status").textContent="调整后自动保存";
  if(isDrawerLayout()) {el.inspectorEl.classList.add("is-open");syncDrawerBackdrop();}
  syncWordRailChrome(); requestAnimationFrame(paintWordRailWave); syncChrome();
}
function savePauseBoundary() {
  const clip=project?.clips.find(c=>c.id===activePause?.clipId);
  if(!clip||!wordRailState||!activePause) return;
  const {selStart:start,selEnd:end}=wordRailState;
  if(start<0||end>clip.duration||end-start<.02-1e-7) {document.querySelector("#word-boundary-status").textContent="停顿边界超出范围，尚未保存";return;}
  const state=activePause;
  if(Math.abs(start-wordRailState.focusStart)<1e-6&&Math.abs(end-wordRailState.focusEnd)<1e-6) return;
  pushUndo(clip);
  if(state.cleared) {
    const id=crypto.randomUUID(); replacePauseCut(clip,new Set(state.parts.map(p=>p.id)),{start,end},id);
    state.parts=clip.clearedPauses.filter(p=>p.id.startsWith(id)).map(p=>({...p,cleared:true}));
    state.removedParts=state.parts;
    clip.manualPauses=(clip.manualPauses??[]).filter(m=>!(m.start<state.sourceEnd&&m.end>state.sourceStart));
  } else {
    const id=state.manualId??crypto.randomUUID();state.manualId=id;
    clip.manualPauses=(clip.manualPauses??[]).filter(m=>m.id!==id && !(m.start<state.sourceEnd&&m.end>state.sourceStart));
    state.sourceStart=Math.min(state.sourceStart,start);state.sourceEnd=Math.max(state.sourceEnd,end);
    clip.manualPauses.push({id,start,end,sourceStart:state.sourceStart,sourceEnd:state.sourceEnd});
    state.parts=[{id,start,end}];
  }
  wordRailState.focusStart=start; wordRailState.focusEnd=end;
  syncEngineFromProject(); renderTrack();renderTranscript();syncChrome();paintWordRailWave();
  el.wordRailMeta.textContent=`${start.toFixed(3)}–${end.toFixed(3)}s`;
  scheduleDraftSave();document.querySelector("#word-boundary-status").textContent="正在自动保存…";
  void flushDraftSave({toastFail:true}).then(ok=>{if(activePause===state)document.querySelector("#word-boundary-status").textContent=ok?"✓ 已自动保存":"未保存 · 点击上方重试";});
}
function deleteSelectedPause() {
  if(!activePause||activePause.cleared||!wordRailState||!readWordBoundaryInputs()) return;
  savePauseBoundary();
  const clip=project.clips.find(c=>c.id===activePause.clipId);if(!clip)return;
  pushUndo(clip);
  const {selStart:start,selEnd:end}=wordRailState;
  const id=crypto.randomUUID();
  const parts=activePause.parts.map(p=>({start:Math.max(start,p.start),end:Math.min(end,p.end)})).filter(p=>p.end>p.start);
  const added=deletePauseParts(clip,parts,id);
  if(!added.length) { toast("这段范围没有可删除的停顿"); return; }
  const allCuts=[...(activePause.removedParts??[]),...added.map(p=>({...p,cleared:true}))];
  const state={...activePause,cleared:true,parts:allCuts,removedParts:allCuts};
  syncEngineFromProject();renderTrack();renderTranscript();showPauseRail(clip,state,Math.min(...allCuts.map(p=>p.start)),Math.max(...allCuts.map(p=>p.end)));scheduleDraftSave();
}
function restoreSelectedPause() {
  if(!activePause || !(activePause.removedParts?.length || activePause.cleared))return;
  const clip=project.clips.find(c=>c.id===activePause.clipId);if(!clip)return;
  pushUndo(clip);const restored=activePause.removedParts??activePause.parts;const ids=new Set(restored.map(p=>p.id));
  for(const p of clip.clearedPauses??[]) if(ids.has(p.id)) clip.ranges=addRange(clip.ranges,p.start,p.end);
  clip.clearedPauses=(clip.clearedPauses??[]).filter(p=>!ids.has(p.id));
  for(const w of clip.words) if(w.deleted&&!isPunctText(w.text)) for(const p of w.removedAudio??[{start:w.start,end:w.end}]) clip.ranges=removeRange(clip.ranges,p.start,p.end);
  for(const p of clip.clearedPauses)clip.ranges=removeRange(clip.ranges,p.start,p.end);
  const kept=activePause.cleared?[]:activePause.parts;
  const parts=[...kept,...restored.map(p=>({...p,cleared:false}))];
  const state={...activePause,cleared:false,parts,removedParts:[]};
  syncEngineFromProject();renderTrack();renderTranscript();showPauseRail(clip,state,Math.min(...parts.map(p=>p.start)),Math.max(...parts.map(p=>p.end)));scheduleDraftSave();
}
function openWordAudioRail(clipId, wordId) {
  activePause = null; activeMusicId = null; renderMusicInspector();
  window.clearTimeout(boundarySaveTimer);
  if (!project) return;
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return;
  const word = clip.words.find((w) => w.id === wordId);
  if (!word) return;
  const ext = { start: word.start, end: Math.max(word.end, word.start + 0.02) };
  if (word.deleted && word.removedAudio?.length) {
    ext.start = Math.min(word.start,...word.removedAudio.map(r=>r.start));
    ext.end = Math.max(word.end,...word.removedAudio.map(r=>r.end));
  }
  const focusStart = Math.max(0, ext.start);
  const focusEnd = Math.min(clip.duration, Math.max(ext.end, focusStart + 0.02));
  const view = viewWindowAround(
    { start: focusStart, end: focusEnd },
    clip.duration,
    0.4,
  );
  wordRailState = {
    clipId,
    wordId,
    viewStart: view.start,
    viewEnd: view.end,
    focusStart,
    focusEnd,
    selStart: focusStart,
    selEnd: focusEnd,
  };
  document.querySelector("#word-rail").hidden = false;
  document.querySelector("#word-rail-empty").hidden = true;
  document.querySelector("#word-boundary-status").textContent = word.deleted ? "调整切口后自动保存" : "调整后自动保存";
  // B10 urgent: boolean .hidden=false can leave attribute hidden="" on <details>
  // in some paths; always strip the attribute so the panel paints.
  const rail = el.wordRailGroup;
  rail.removeAttribute("hidden");
  rail.hidden = false;
  rail.open = true;
  rail.classList.add("is-open");
  rail.style.removeProperty("display");
  el.wordRailLabel.textContent =
    (word.deleted ? "已删 · " : "") +
    (isPunctText(word.text) ? "标点 " : "") +
    "「" +
    word.text +
    "」";
  el.wordRailMeta.textContent =
    (word.manualBoundary ? "手动字界 · " : !!word.alignmentSource ? "声学对齐 · " : "字界 · ") + word.start.toFixed(2) + "–" + word.end.toFixed(2) + "s";
  // Desktop: inspector is already in the 3-pane grid — do NOT show #drawer-backdrop
  // (it steals pointer events). Only slide inspector + backdrop on narrow drawer layout.
  try {
    el.inspectorEl.removeAttribute("hidden");
    if (isDrawerLayout()) {
      el.inspectorEl.classList.add("is-open");
      syncDrawerBackdrop();
    } else {
      el.inspectorEl.classList.remove("is-open");
      syncDrawerBackdrop();
    }
    requestAnimationFrame(() => {
      try {
        rail.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } catch {
        /* */
      }
    });
  } catch {
    /* */
  }
  syncWordRailChrome();
  requestAnimationFrame(paintWordRailWave);
}
function closeWordAudioRail() {
  stopAudition(); activePause = null; wordRailState = null; wordRailDrag = null; syncSelectionBar();
  document.querySelector("#word-rail").hidden = true;
  document.querySelector("#word-rail-empty").hidden = false;
  el.wordRailGroup.open = true;
}
function readWordBoundaryInputs() {
  if (!wordRailState) return false;
  const start = document.querySelector("#boundary-start");
  const end = document.querySelector("#boundary-end");
  const a = start.valueAsNumber, b = end.valueAsNumber;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b - a < 0.02 - 1e-7) { document.querySelector("#word-boundary-status").textContent = "字界无效，尚未保存（选区至少 0.02 秒）"; return false; }
  wordRailState.selStart = a; wordRailState.selEnd = b;
  if(a>=0 && b<=(project?.clips.find(c=>c.id===wordRailState.clipId)?.duration??0)) { wordRailState.viewStart=Math.min(wordRailState.viewStart,a); wordRailState.viewEnd=Math.max(wordRailState.viewEnd,b); }
  return true;
}
let boundarySaveTimer = 0;
function saveWordBoundary() {
  window.clearTimeout(boundarySaveTimer);
  boundarySaveTimer = 0;
  if (!readWordBoundaryInputs() || !wordRailState || !project) return;
  if (activePause) { savePauseBoundary(); return; }
  const clip = project.clips.find(c => c.id === wordRailState.clipId);
  const word = clip?.words.find(w => w.id === wordRailState.wordId);
  if (!word || isPunctText(word.text)) return;
  const a = wordRailState.selStart, b = wordRailState.selEnd;
  if (Math.abs(a-word.start)<1e-6 && Math.abs(b-word.end)<1e-6) { document.querySelector("#word-boundary-status").textContent = "字界未改变"; return; }
  if (a < 0 || b > clip.duration || b-a < 0.02-1e-7) {
    document.querySelector("#word-boundary-status").textContent = "时间超出音频范围，尚未保存"; return;
  }
  pushUndo(clip);
  normalizeMusicAnchors();
  updateWordBoundary(clip, word, a, b);
  syncEngineFromProject(); renderTrack(); renderMusicInspector();
  renderTranscript(); syncChrome(); scheduleDraftSave();
  wordRailState.focusStart = a; wordRailState.focusEnd = b;
  el.wordRailMeta.textContent = (word.deleted ? "切口 · " : "字界 · ") + a.toFixed(3) + "–" + b.toFixed(3) + "s";
  paintWordRailWave();
  document.querySelector("#word-boundary-status").textContent = "正在自动保存…";
  const editing = wordRailState;
  void flushDraftSave({toastFail:true}).then(ok => {
    if (wordRailState === editing) document.querySelector("#word-boundary-status").textContent = ok ? "✓ 已自动保存" : "未保存 · 点击上方状态重试";
  });
}
function cutWordRailSelection() {
  if (activePause) { deleteSelectedPause(); return; }
  if (!readWordBoundaryInputs()) return;
  if (!wordRailState || !project) return;
  const clip = project.clips.find((c) => c.id === wordRailState.clipId);
  if (!clip) return;
  clampRailSel();
  const a = wordRailState.selStart;
  const b = wordRailState.selEnd;
  if (b - a < 1e-3) {
    toast("选区太短");
    return;
  }
  const word = clip.words.find(w => w.id === wordRailState.wordId);
  if (!word || isPunctText(word.text)) { toast("标点没有独立发音，不剪音频"); return; }
  // User selection always wins — cut exactly a..b even if it crosses neighbor word times.
  pushUndo(clip);
  stopAudition();
  for (const r of word.removedAudio ?? []) clip.ranges = addRange(clip.ranges, r.start, r.end);
  for (const w of clip.words.filter(w => w !== word && w.deleted)) {
    for (const r of w.removedAudio ?? [{ start: w.start, end: w.end }]) clip.ranges = removeRange(clip.ranges, r.start, r.end);
  }
  for (const p of clip.clearedPauses ?? []) clip.ranges = removeRange(clip.ranges, p.start, p.end);
  word.removedAudio = clip.ranges.map(r => ({ start: Math.max(a, r.start), end: Math.min(b, r.end) })).filter(r => r.end > r.start);
  clip.ranges = removeRange(clip.ranges, a, b);
  word.start = a; word.end = b; word.deleted = true; word.estimated = false; word.manualBoundary = true;
  activeClipId = clip.id;
  syncEngineFromProject();
  renderTrack();
  renderTranscript();
  syncChrome();
  scheduleDraftSave();
  toast("已切除选区音频 " + (b - a).toFixed(2) + "s");
  // Keep rail open with same view; selection collapses to a caret at cut start
  wordRailState.selStart = a;
  wordRailState.selEnd = Math.min(b, a + 0.05);
  openWordAudioRail(clip.id, wordRailState.wordId);
}
let auditionContext = null;
let auditionSource = null;
function stopAudition() { try { auditionSource?.stop(); } catch {} auditionSource = null; }
function previewWordRailSelection(context = false) {
  if (!readWordBoundaryInputs()) return;
  if (!wordRailState || !project) return;
  const clip = project.clips.find(c => c.id === wordRailState.clipId);
  if (!clip) return;
  clampRailSel();
  engine.pause(); stopAudition();
  auditionContext ??= new AudioContext();
  void auditionContext.resume();
  const start = Math.max(0, wordRailState.selStart - (context ? 0.45 : 0));
  const end = Math.min(clip.duration, wordRailState.selEnd + (context ? 0.45 : 0));
  auditionSource = auditionContext.createBufferSource();
  auditionSource.buffer = clip.cleanBuffer || clip.buffer;
  auditionSource.connect(auditionContext.destination);
  auditionSource.start(0, start, end - start);
  syncChrome();
}
for (const name of ["start", "end"]) {
  const input = document.querySelector(`#boundary-${name}`);
  input.addEventListener("input", () => {
    if (wordRailState) boundaryEditVersions.set(wordRailState.clipId, (boundaryEditVersions.get(wordRailState.clipId) || 0) + 1);
    window.clearTimeout(boundarySaveTimer);
    document.querySelector("#word-boundary-status").textContent = "编辑中…";
    boundarySaveTimer = window.setTimeout(saveWordBoundary, 650);
  });
  input.addEventListener("change", saveWordBoundary);
  input.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); saveWordBoundary(); } });
}

/** Cut-time energy swallow opts from clip audio (cleanBuffer preferred). */
function cutEnergyOpts(clip) {
  const buf = clip.cleanBuffer || clip.buffer;
  if (!buf || !buf.length) return undefined;
  try {
    return {
      ...bufferAcoustics(buf),
      clipDuration: clip.duration,
      maxSwallowSec: 0.012,
      frameMs: 10,
    };
  } catch {
    return undefined;
  }
}

function deleteWordsByIds(ids) {
  if (!project || ids.size === 0) return;
  const byClip = new Map();
  for (const id of ids) {
    const clip = findClipByWordId(id);
    if (!clip) continue;
    const w = clip.words.find((x) => x.id === id && !x.deleted);
    if (!w) continue;
    const list = byClip.get(clip.id) ?? [];
    list.push(w);
    byClip.set(clip.id, list);
  }
  if (byClip.size === 0) return;
  for (const [clipId, targets] of byClip) {
    const clip = project.clips.find((c) => c.id === clipId);
    pushUndo(clip);

    deleteWordRuns(clip, new Set(targets.map(w => w.id)));
    activeClipId = clipId;
  }
  syncEngineFromProject();
  renderTrack();
  renderTranscript();
  syncChrome();
  scheduleDraftSave();
  if (wordRailState && ids.has(wordRailState.wordId)) openWordAudioRail(wordRailState.clipId, wordRailState.wordId);
  const n = [...byClip.values()].reduce((s, a) => s + a.length, 0);
  const speechN = [...byClip.values()].reduce(
    (s, a) => s + a.filter((w) => !isPunctText(w.text)).length,
    0,
  );
  for (const id of ids) {
    dupFlaggedIds.delete(id);
    dupFlagReasons.delete(id);
  }
  // B5: punct-only delete must not claim audio was cut.
  if (speechN === 0) toast(`已删除 ${n} 处标点（无独立发音，未剪音频）`);
  else toast(`已删除 ${n} 处，音频已同步剪掉`);
}
function clearDupFlags(silent = false) {
  for(const c of project?.clips??[])for(const w of c.words)delete w.duplicateReason;
  scheduleDraftSave();
  dupFlaggedIds = new Set();
  dupFlagReasons = new Map();
  renderTranscript();
  syncChrome();
  if (!silent) toast("已清除重复标记");
}
function applyDupSpans(spans) {
  if (!project) return 0;
  for(const c of project.clips)for(const w of c.words)delete w.duplicateReason;
  const ordered = [];
  for (const clip of project.clips) {
    for (const w of clip.words) {
      if (!w.deleted) ordered.push(w);
    }
  }
  const indexOf = new Map(ordered.map((w, i) => [w.id, i]));
  dupFlaggedIds = new Set();
  dupFlagReasons = new Map();
  let spanCount = 0;
  for (const span of spans) {
    const a = indexOf.get(span.startWordId);
    const b = indexOf.get(span.endWordId);
    if (a == null || b == null) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    spanCount += 1;
    for (let i = lo; i <= hi; i++) {
      const w = ordered[i];
      w.duplicateReason=span.reason;
      dupFlaggedIds.add(w.id);
      dupFlagReasons.set(w.id, span.reason);
    }
  }
  return spanCount;
}
async function runDetectDuplicates() {
  if (detectingDuplicates) return;
  if (!project || project.clips.length === 0) {
    toast("请先加载或转写文字稿");
    return;
  }
  const words = [];
  for (const clip of project.clips) {
    for (const w of clip.words) {
      if (w.deleted) continue;
      words.push({ id: w.id, text: w.text, index: words.length, clipId:clip.id, start:w.start, end:w.end, breakAfter:w.breakAfter });
    }
  }
  if (words.length < 4) {
    toast("文字太少，暂不检测");
    return;
  }
  detectingDuplicates = true;
  el.detectDup.disabled = true;
  const prevLabel = el.detectDup.textContent;
  el.detectDup.textContent = "检测中…";
  toast(`DeepSeek 检测重复中（全部片段 · ${words.length} 字）…`, 8e3);
  try {
    const result = await detectDuplicatesViaProxy(words);
    const current=(project?.clips??[]).flatMap(c=>c.words.filter(w=>!w.deleted).map(w=>[w.id,w.text]));
    if(JSON.stringify(current)!==JSON.stringify(words.map(w=>[w.id,w.text])))throw Error("检测期间文字已改变，请重新运行 标记重复");
    const spanCount = applyDupSpans(result.duplicates);
    scheduleDraftSave();
    renderTranscript();
    syncChrome();
    if (spanCount === 0) {
      toast("未发现明显重录 / 假开头");
    } else {
      toast(
        `标出 ${spanCount} 段疑似重录（${dupFlaggedIds.size} 字，下划线）。拖选后按 Delete 或点「删除」；「清除重复标记」只取消标注`,
        5500
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "检测失败";
    toast(msg, 5500);
  } finally {
    detectingDuplicates = false;
    el.detectDup.textContent = prevLabel || "标记重复";
    syncChrome();
  }
}
function selectedWordsOrdered() {
  const ids = idsForDelete();
  if (ids.size === 0 || !project) return null;
  const ordered = [];
  let clip = null;
  for (const node of el.transcript.querySelectorAll(".word:not(.deleted)")) {
    const id = node.dataset.id;
    if (!id || !ids.has(id)) continue;
    const c = findClipByWordId(id);
    if (!c) continue;
    if (!clip) clip = c;
    if (c.id !== clip.id) {
      toast("复制请在同一音频片段内选择");
      return null;
    }
    const w = c.words.find((x) => x.id === id && !x.deleted);
    if (w) ordered.push(w);
  }
  if (!clip || ordered.length === 0) return null;
  return { clip, words: ordered };
}
function nextPasteWordId(clipId) {
  let id;
  do { wordIdSeq += 1; id = `${clipId}-p${wordIdSeq}`; } while (project?.clips.some(c => c.words.some(w => w.id === id)));
  return id;
}
function mapThroughGlue(t, srcPieces, destPieces) {
  for (let i = 0; i < srcPieces.length; i++) {
    const s = srcPieces[i];
    const d = destPieces[i];
    if (t + 1e-6 >= s.start && t <= s.end + 1e-6) {
      const rel = Math.min(Math.max(0, t - s.start), s.end - s.start);
      return d.start + rel;
    }
  }
  if (destPieces.length === 0) return 0;
  return destPieces[destPieces.length - 1].end;
}
function copySelectedWords() {
  const picked = selectedWordsOrdered();
  if (!picked) {
    toast("先拖选要复制的文字");
    return false;
  }
  const { clip, words } = picked;
  const spanStart = Math.min(...words.map(w => editTimeBeforeWord(clip, w)));
  const spanEnd = Math.max(...words.map(w => editTimeAfterWord(clip, w)));
  const srcPieces = extractEditRanges(clip.ranges, spanStart, spanEnd);
  if (srcPieces.length === 0) {
    toast("选中文字没有可复制的音频（可能已被剪掉）");
    return false;
  }
  const gluedClean = glueRangesFromBuffer(clip.cleanBuffer, srcPieces);
  const gluedPlay = glueRangesFromBuffer(clip.buffer, srcPieces);
  if (!gluedClean || !gluedPlay) {
    toast("复制音频失败");
    return false;
  }
  const mapped = words.map((w) => {
    const relStart = mapThroughGlue(w.start, srcPieces, gluedClean.destRanges);
    const relEnd = mapThroughGlue(w.end, srcPieces, gluedClean.destRanges);
    return {
      text: w.text,
      relStart: Math.min(relStart, relEnd),
      relEnd: Math.max(relStart, relEnd),
      breakAfter: w.breakAfter,
      speakerId: w.speakerId,
      speakerName: w.speakerName
    };
  });
  const plainText = words.map((w) => w.text).join("");
  wordClipboard = {
    words: mapped,
    cleanBuffer: gluedClean.buffer,
    playBuffer: gluedPlay.buffer,
    plainText
  };
  try {
    void navigator.clipboard?.writeText(plainText);
  } catch {
  }
  syncChrome();
  toast(`已复制 ${words.length} 字（含音频 ${gluedClean.buffer.duration.toFixed(2)}s）`);
  return true;
}
function editTimeAfterWord(clip, word) {
  let t = 0;
  for (const r of clip.ranges) {
    if (word.end > r.start + 1e-6 && word.end <= r.end + 1e-6) return t + word.end - r.start;
    t += r.end - r.start;
  }
  return toEdit(clip.ranges, word.start) ?? editedDuration(clip.ranges);
}
function editTimeBeforeWord(clip, word) {
  const at = toEdit(clip.ranges, word.start);
  return at != null ? at : 0;
}
function resolvePasteInsert(clip, forceStart = false) {
  if (forceStart) {
    return { insertAt: 0, editInsertAt: 0 };
  }
  let insertAt = clip.words.length;
  let editInsertAt = editedDuration(clip.ranges);
  if (activeWordId) {
    const idx = clip.words.findIndex((w) => w.id === activeWordId);
    if (idx >= 0) {
      const word = clip.words[idx];
      if (pasteSide === "before") {
        insertAt = idx;
        editInsertAt = editTimeBeforeWord(clip, word);
      } else {
        insertAt = idx + 1;
        editInsertAt = editTimeAfterWord(clip, word);
      }
    }
  }
  return { insertAt, editInsertAt };
}
function pasteWordsAtAnchor(forceStart = false) {
  if (!project || !wordClipboard) {
    toast("剪贴板为空，请先复制文字");
    return false;
  }
  const clip = (activeWordId ? findClipByWordId(activeWordId) : null) ?? getActiveClip();
  if (!clip) {
    toast("请先点一下要粘贴到的字，或点开头的 | 光标");
    return false;
  }
  const { insertAt, editInsertAt } = resolvePasteInsert(clip, forceStart);
  const cleanExtra = wordClipboard.cleanBuffer;
  const playExtra = wordClipboard.playBuffer;
  if (Math.abs(cleanExtra.sampleRate - clip.cleanBuffer.sampleRate) > 1) {
    toast("采样率不一致，无法粘贴到该片段");
    return false;
  }
  pushUndo(clip);
  const base = clip.cleanBuffer.duration;
  clip.cleanBuffer = concatAudioBuffers(clip.cleanBuffer, cleanExtra);
  clip.bufferDirty = true;
  clip.sourceBlob = undefined;
  clip.sourceMime = undefined;
  let playAppend = playExtra;
  if (Math.abs(playExtra.sampleRate - clip.buffer.sampleRate) > 1 || Math.abs(playExtra.duration - cleanExtra.duration) > 0.05) {
    playAppend = cleanExtra;
  }
  if (Math.abs(clip.buffer.duration - base) > 0.05) {
    clip.buffer = concatAudioBuffers(sliceKeepDuration(clip.buffer, base), playAppend);
  } else {
    clip.buffer = concatAudioBuffers(clip.buffer, playAppend);
  }
  const order = clip.audioOrder;
  const anchor = activeWordId && clip.words.find(w => w.id === activeWordId);
  const fullInsert = forceStart ? 0 : anchor
    ? pasteSide === "before" ? editTimeBeforeWord({ranges:order}, anchor) : editTimeAfterWord({ranges:order}, anchor)
    : editedDuration(order);
  clip.audioOrder = insertRangesAt(order, fullInsert, [{start:base,end:base+cleanExtra.duration}]);
  clip.ranges = insertRangesAt(clip.ranges, editInsertAt, [
    { start: base, end: base + cleanExtra.duration }
  ]);
  clip.duration = clip.cleanBuffer.duration;
  const newWords = wordClipboard.words.map((w) => ({
    id: nextPasteWordId(clip.id),
    text: w.text,
    start: base + w.relStart,
    end: base + Math.max(w.relEnd, w.relStart + 1e-3),
    deleted: false,
    breakAfter: w.breakAfter,
    speakerId: w.speakerId,
    speakerName: w.speakerName
  }));
  clip.words.splice(insertAt, 0, ...newWords);
  activeClipId = clip.id;
  pasteSide = "after";
  if (newWords.length) {
    activeWordId = newWords[newWords.length - 1].id;
  }
  syncEngineFromProject();
  renderTrack();
  renderTranscript();
  syncChrome();
  scheduleDraftSave();
  const where = forceStart || insertAt === 0 && editInsertAt === 0 ? "开头" : "光标处";
  toast(`已粘贴到${where} ${newWords.length} 字（音频 +${cleanExtra.duration.toFixed(2)}s）`);
  return true;
}
function pasteWordsAtStart() {
  if (!project || !wordClipboard) {
    toast("剪贴板为空，请先复制文字");
    return false;
  }
  const clip = (activeWordId ? findClipByWordId(activeWordId) : null) ?? getActiveClip();
  if (!clip) {
    toast("请先选择一个片段");
    return false;
  }
  activeClipId = clip.id;
  const first = clip.words.find((w) => !w.deleted);
  if (first) {
    activeWordId = first.id;
    pasteSide = "before";
  }
  return pasteWordsAtAnchor(true);
}
function sliceKeepDuration(buf, durationSec) {
  const sr = buf.sampleRate;
  const length = Math.max(1, Math.floor(durationSec * sr));
  const out = new AudioBuffer({
    length,
    numberOfChannels: buf.numberOfChannels,
    sampleRate: sr
  });
  const copyLen = Math.min(length, buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.copyToChannel(buf.getChannelData(c).subarray(0, copyLen).slice(0), c);
  }
  return out;
}
function selectedWordIds(opts) {
  const includeDeleted = opts?.includeDeleted !== false; // B9: default include
  const sel = window.getSelection();
  const ids = new Set();
  if (!sel || sel.isCollapsed) return ids;
  if (!el.transcript.contains(sel.anchorNode) && !el.transcript.contains(sel.focusNode)) {
    return ids;
  }
  for (const node of selectedWordElements(el.transcript,sel)) {
    if (!includeDeleted && node.classList.contains("deleted")) continue;
    if (!node.dataset.id) continue;
    ids.add(node.dataset.id);
    if (node.dataset.clipId) activeClipId = node.dataset.clipId;
  }
  return ids;
}
/** Programmatically select one word span so Delete/Backspace and the selection bar work after a click. */
function selectWordElement(node) {
  if (!(node instanceof HTMLElement)) return;
  const range = document.createRange();
  try {
    range.selectNodeContents(node);
  } catch {
    return;
  }
  el.transcript.focus({ preventScroll: true });
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  syncSelectionBar();
}
/** Ids to delete: drag/DOM selection first; else the click-focused active word. */
function idsForDelete() {
  const ids = selectedWordIds({ includeDeleted: false });
  if (ids.size > 0 || !window.getSelection()?.isCollapsed) return ids;
  if (!activeWordId || !project) return ids;
  const clip = findClipByWordId(activeWordId);
  const w = clip?.words.find((x) => x.id === activeWordId);
  if (w && !w.deleted) return new Set([activeWordId]);
  return ids;
}
function selectedDeletedWordIds() {
  const ids = selectedWordIds({ includeDeleted: true });
  if (!project) return new Set();
  if (!ids.size && activeWordId) ids.add(activeWordId);
  const out = new Set();
  for (const id of ids) {
    const clip = findClipByWordId(id);
    const w = clip?.words.find((x) => x.id === id);
    if (w?.deleted) out.add(id);
  }
  return out;
}
function restoreWordsByIds(ids) {
  if (!project || ids.size === 0) return;
  const byClip = new Map();
  for (const id of ids) {
    const clip = findClipByWordId(id);
    if (!clip) continue;
    const w = clip.words.find((x) => x.id === id && x.deleted);
    if (!w) continue;
    const list = byClip.get(clip.id) ?? [];
    list.push(w);
    byClip.set(clip.id, list);
  }
  if (byClip.size === 0) {
    toast("选区没有可复原的已删字");
    return;
  }
  let n = 0;
  for (const [clipId, targets] of byClip) {
    const clip = project.clips.find((c) => c.id === clipId);
    pushUndo(clip);
    n += restoreWordRuns(clip, new Set(targets.map(w=>w.id)));
    activeClipId = clipId;
  }
  syncEngineFromProject();
  renderTrack();
  renderTranscript();
  syncChrome();
  scheduleDraftSave();
  if (wordRailState) openWordAudioRail(wordRailState.clipId,wordRailState.wordId);
  toast(`已复原 ${n} 处文字+音频`);
}
function removePauses(ev) {
  // B7: default GLOBAL — all clips. Hold Shift for active clip only.
  if (!project || project.clips.length === 0) return;
  const onlyActive = !!(ev && ev.shiftKey);
  const targets = onlyActive
    ? [getActiveClip()].filter(Boolean)
    : project.clips.slice();
  if (targets.length === 0) return;
  closeWordAudioRail();
  let totalPauses = 0;
  let removed = 0;
  let touched = 0;
  for (const clip of targets) {
    const pauseCuts = clipPauseGroups(clip).map(g=>groupBulkCuts(g,clip)).filter(parts=>parts.length);
    if (pauseCuts.length === 0) continue;
    pushUndo(clip);
    if (!clip.clearedPauses) clip.clearedPauses = [];
    let ranges = cloneRanges(clip.ranges);
    for (const parts of pauseCuts) {
      let removedHere=0;
      for (const p of parts) {
      const before = editedDuration(ranges);
      ranges = removeRange(ranges, p.start, p.end);
      const cut = before - editedDuration(ranges);
      if (cut > 1e-4) {
        pauseIdSeq += 1;
        clip.clearedPauses.push({
          id: crypto.randomUUID(),
          start: p.start,
          end: p.end,
        });
        removed += cut;
        removedHere += cut;
      }
      }
      if(removedHere>1e-4) totalPauses += 1;
    }
    clip.ranges = ranges;
    touched += 1;
  }
  if (totalPauses === 0) {
    toast(
      onlyActive
        ? `当前片段未找到 > ${thresholdSec.toFixed(2)}s 的停顿`
        : `全部片段未找到 > ${thresholdSec.toFixed(2)}s 的停顿`,
    );
    return;
  }
  syncEngineFromProject();
  renderTrack();
  renderTranscript();
  syncChrome();
  scheduleDraftSave();
  toast(
    onlyActive
      ? `「${targets[0].name}」已清除 ${totalPauses} 段停顿，约省 ${removed.toFixed(1)}s（Shift＝仅当前段）`
      : `已对 ${touched} 个片段清除 ${totalPauses} 段停顿，约省 ${removed.toFixed(1)}s（全局；Shift＝仅当前段）`,
    4200,
  );
}
function restoreClearedPause(clipId, pauseId) {
  if (!project) return;
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip?.clearedPauses) return;
  const group = clipPauseGroups(clip).find(g => g.id === pauseId);
  if (!group) return;
  const parts = group.parts.filter(p => p.cleared);
  pushUndo(clip);
  for (const p of parts) clip.ranges = addRange(clip.ranges,p.start,p.end);
  const ids = new Set(parts.map(p => p.id));
  clip.clearedPauses = clip.clearedPauses.filter(p => !ids.has(p.id));
  for (const w of clip.words.filter(w => w.deleted && !isPunctText(w.text))) {
    for (const r of w.removedAudio ?? [{start:w.start,end:w.end}]) clip.ranges = removeRange(clip.ranges,r.start,r.end);
  }
  for (const p of clip.clearedPauses) clip.ranges = removeRange(clip.ranges,p.start,p.end);
  activeClipId = clipId;
  syncEngineFromProject();
  renderTrack();
  renderTranscript();
  syncChrome();
  scheduleDraftSave();
  toast(`已复原这段停顿（${parts.reduce((sum,p) => sum+p.end-p.start,0).toFixed(2)}s）`);
}
function doUndo() { travelHistory(false); }
function doRedo() { travelHistory(true); }
function travelHistory(redo) {
  if (!project) return;
  const clipId = redo ? undo.redoClipId : undo.undoClipId;
  if (!clipId) return;
  const clip = project.clips.find(c => c.id === clipId);
  if (!clip) { toast("操作目标片段已不存在"); return; }
  const current = clipSnapshot(clip);
  const snap = redo ? undo.redo(current) : undo.pop(current);
  if (!snap) return;
  clip.words = cloneWords(snap.words);
  clip.ranges = cloneRanges(snap.ranges);
  clip.audioOrder = snap.audioOrder?.map(r => ({...r}));
  if (typeof snap.duration === "number" && snap.duration > 0) {
    clip.duration = snap.duration;
  }
  clip.clearedPauses = (snap.clearedPauses ?? []).map((x) => ({ ...x }));
  clip.manualPauses = (snap.manualPauses ?? []).map(p=>({...p}));
  activePause = null; closeWordAudioRail();
  activeClipId = clip.id;
  syncEngineFromProject();
  renderTrack();
  renderTranscript();
  syncChrome();
  if (wordRailState) openWordAudioRail(wordRailState.clipId, wordRailState.wordId);
  toast(`已${redo ? "重做" : "撤销"}「${clip.name}」`);
  scheduleDraftSave();
}
async function rebuildClipAudio(clip, flags = {}) {
  const clean = clip.cleanBuffer;
  const processed = await applyVoiceProcessing(clean, {
    denoise: flags.denoise ?? clip.denoised,
    beautify: flags.beautify ?? clip.beautified
  });
  if (clip.cleanBuffer !== clean) { toast("处理期间音频有修改，已保留修改，请重试", 3500); return false; }
  if (Math.abs(processed.duration - clip.cleanBuffer.duration) > 0.05) {
    toast("处理后时长异常，已取消", 3500);
    return false;
  }
  clip.buffer = processed;
  return true;
}
async function toggleDenoise() {
  const clip = getActiveClip();
  if (!clip) return;
  el.denoise.disabled = true;
  el.beautify.disabled = true;
  const turningOn = !clip.denoised;
  try {
    if (turningOn) {
      toast("正在温和降噪（保留人声频段）…", 3e4);
    } else {
      toast(
        clip.beautified ? "正在关闭降噪并保留美化…" : "正在还原…",
        3e4
      );
    }
    const ok = await rebuildClipAudio(clip, {denoise: turningOn});
    if (!ok) {
      return;
    }
    clip.denoised = turningOn;
    syncEngineFromProject();
    scheduleDraftSave();
    renderTrack();
    syncChrome();
    toast(
      turningOn ? `「${clip.name}」已温和降噪（再点可关）` : clip.beautified ? `「${clip.name}」已关闭降噪（美化仍开）` : `「${clip.name}」已还原原始音频`
    );
  } catch (err) {
    console.error(err);
    toast(`降噪失败：${err?.message || "请重试"}`, 5000);
  } finally {
    syncDenoiseButton();
    syncBeautifyButton();
    const ready = !!project && project.clips.length > 0;
  syncAlignmentUi();
  app.classList.toggle("has-project", ready);
  if (!engine.isPlaying()) setReadingHighlight(null);
    el.denoise.disabled = !ready;
    el.beautify.disabled = !ready;
  }
}
async function toggleBeautify() {
  const clip = getActiveClip();
  if (!clip) return;
  el.denoise.disabled = true;
  el.beautify.disabled = true;
  const turningOn = !clip.beautified;
  try {
    if (turningOn) {
      toast("正在人声美化（轻微清晰度 + 柔化）…", 3e4);
    } else {
      toast(
        clip.denoised ? "正在关闭美化并保留降噪…" : "正在还原…",
        3e4
      );
    }
    const ok = await rebuildClipAudio(clip, {beautify: turningOn});
    if (!ok) {
      return;
    }
    clip.beautified = turningOn;
    syncEngineFromProject();
    scheduleDraftSave();
    renderTrack();
    syncChrome();
    toast(
      turningOn ? `「${clip.name}」已人声美化（再点可关）` : clip.denoised ? `「${clip.name}」已关闭美化（降噪仍开）` : `「${clip.name}」已还原原始音频`
    );
  } catch (err) {
    console.error(err);
    toast("人声美化失败");
  } finally {
    syncDenoiseButton();
    syncBeautifyButton();
    const ready = !!project && project.clips.length > 0;
  syncAlignmentUi();
  app.classList.toggle("has-project", ready);
  if (!engine.isPlaying()) setReadingHighlight(null);
    el.denoise.disabled = !ready;
    el.beautify.disabled = !ready;
  }
}
function moveClip(id, dir) {
  if (!project) return;
  const idx = project.clips.findIndex((c) => c.id === id);
  const j = idx + dir;
  if (idx < 0 || j < 0 || j >= project.clips.length) return;
  const tmp = project.clips[idx];
  project.clips[idx] = project.clips[j];
  project.clips[j] = tmp;
  activeClipId = id;
  refreshAfterClipsChange();
}
function removeClip(id) {
  if (!project) return;
  const idx = project.clips.findIndex((c) => c.id === id);
  if (idx < 0) return;
  project.clips.splice(idx, 1);
  if (project.clips.length === 0) {
    // B4: emptying clips must NOT cancel background ASR (only 「清空项目」does).
    engine.stop();
    engine.setFallbackUrl(null);
    undo.clear();
    project = null;
    activeWordId = null;
    pasteSide = "after";
    activeClipId = null;
    activeMusicId = null;
    engine.setClips([]);
    engine.setMixSchedule(null);
    dupFlaggedIds = new Set();
    dupFlagReasons = new Map();
    wordClipboard = null;
    renderTrack();
    renderMusicInspector();
    renderTranscript();
    syncChrome();
    ensureImportControlsEnabled();
    toast("已移除片段");
    draftAllowClear = true;
    draftRecoveryBlocked = false;
    scheduleDraftSave();
    void flushDraftSave();
    return;
  }
  activeClipId = project.clips[Math.min(idx, project.clips.length - 1)].id;
  refreshAfterClipsChange();
  toast("已移除片段");
}
async function refreshSfxLibrary() {
  try {
    sfxLibrary = await listSfxLibrary();
  } catch (err) {
    console.error(err);
    sfxLibrary = [];
  }
  renderSfxLibrary();
}
function renderSfxLibrary() {
  el.sfxList.innerHTML = "";
  if (sfxLibrary.length === 0) {
    el.sfxList.dataset.empty = "1";
    return;
  }
  delete el.sfxList.dataset.empty;
  for (const [idx, item] of sfxLibrary.entries()) {
    const card = document.createElement("div");
    card.className = "track-block sfx-card";
    card.setAttribute("role", "listitem");
    card.draggable = true;
    card.dataset.libraryId = item.id;
    card.innerHTML = `
      <span class="track-grip" title="拖到文字稿使用" aria-hidden="true">⋮⋮</span>
      <span class="track-idx">${idx + 1}</span>
      <span class="track-main">
        <span class="track-name sfx-name" title="拖到文字稿使用">${escapeHtml(item.name)}</span>
        <span class="track-meta"><span class="sfx-dur">${fmt(item.duration)}</span> · <span class="sfx-tag">${escapeHtml(item.tag)}</span></span>
      </span>
      <span class="track-actions sfx-card-actions">
        <button type="button" class="btn-icon" data-sfx-act="rename" title="重命名" aria-label="重命名素材">✎</button>
        <button type="button" class="btn-icon" data-sfx-act="tag" title="改标签" aria-label="修改素材标签"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2 2h6l6 6-6 6-6-6Z"/><circle cx="5" cy="5" r="1"/></svg></button>
        <button type="button" class="btn-icon" data-sfx-act="del" title="删除">×</button>
      </span>
    `;
    el.sfxList.appendChild(card);
  }
}
async function ensureLibraryBuffer(id) {
  const cached = libraryBuffers.get(id);
  if (cached) return cached;
  const blob = await getSfxBlob(id);
  if (!blob) return null;
  const buf = await engine.decodeArrayBuffer(await blob.arrayBuffer());
  libraryBuffers.set(id, buf);
  return buf;
}
async function addSfxFiles(files) {
  const list = Array.from(files);
  if (list.length === 0) return;
  let added = 0;
  const tag = el.sfxTagDefault.value || "过场";
  for (const file of list) {
    try {
      const ab = await file.arrayBuffer();
      const audioBuf = await engine.decodeArrayBuffer(ab);
      const name = file.name.replace(/\.[^.]+$/, "") || "音效";
      const meta = await addSfxToLibrary({
        name,
        tag,
        blob: new Blob([ab], { type: file.type || "audio/wav" }),
        duration: audioBuf.duration
      });
      libraryBuffers.set(meta.id, audioBuf);
      added += 1;
      toast(`已保存到常用：${meta.name}（${meta.tag}）`);
    } catch (err) {
      console.error(err);
      toast(`导入失败：${file.name}，请检查文件是否为可播放音频`);
    }
  }
  await refreshSfxLibrary();
  return added;
}
async function loadSfxFromUrl() {
  const button = document.querySelector('#btn-sfx-url');
  const input = document.querySelector('#sfx-audio-url');
  const status = document.querySelector('#sfx-url-status');
  if (button.disabled) return;
  button.disabled = true; input.readOnly = true;
  status.hidden = false; status.textContent = '正在下载音频…';
  try {
    const file = await downloadAudioFile(input.value);
    status.textContent = '正在读取音频并保存到素材库…';
    const added = await addSfxFiles([file]);
    if (!added) throw new Error('文件无法作为音频读取，请检查直链或从本地导入');
    input.value = ''; status.hidden = true; closeAllMenus();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'URL 导入失败，请重试';
  } finally { button.disabled = false; input.readOnly = false; }
}
async function importDemoSfx(opts) {
  const existing = await listSfxLibrary();
  const names = new Set(existing.map((x) => x.name));
  let added = 0;
  for (const spec of DEMO_SFX) {
    if (!opts?.force && names.has(spec.name)) continue;
    try {
      const res = await fetch(spec.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      const audioBuf = await engine.decodeArrayBuffer(ab);
      const meta = await addSfxToLibrary({
        name: spec.name,
        tag: spec.tag,
        blob: new Blob([ab], { type: "audio/wav" }),
        duration: audioBuf.duration
      });
      libraryBuffers.set(meta.id, audioBuf);
      names.add(spec.name);
      added += 1;
    } catch (err) {
      console.error(err);
      toast(`演示配乐导入失败：${spec.name}`);
    }
  }
  if (added > 0) {
    markDemoSfxSeeded();
    await refreshSfxLibrary();
  }
  return added;
}
async function seedDemoSfxIfEmpty() {
  try {
    const existing = await listSfxLibrary();
    if (existing.length > 0) {
      markDemoSfxSeeded();
      return;
    }
    if (wasDemoSfxSeeded()) return;
    const n = await importDemoSfx();
    if (n > 0) toast(`已自动导入 ${n} 条科技演示配乐（开头 / 过场 / 结尾）`);
  } catch (err) {
    console.error(err);
  }
}
function formatPlacementGain(db) {
  const r = Math.round(db * 2) / 2;
  if (Math.abs(r) < 1e-6) return "0 dB";
  return `${r > 0 ? "+" : ""}${r} dB`;
}
function findAnchorLabel(m) {
  if (!project) return "";
  const clip = project.clips.find((c) => c.id === m.clipId);
  if (!clip) return "";
  let w = null;
  if (m.wordId) w = clip.words.find((x) => x.id === m.wordId) ?? null;
  if (!w) w = wordAtOriginal(clip.words, m.originalTime);
  const text = w ? w.text : "?";
  return `「${text}」${musicAnchorSide(m, clip.words) === "after" ? "之后" : "之前"} · ${clip.name}`;
}
function renderMusicInspector() {
  if (!project || !activeMusicId) {
    el.musicInspector.hidden = true;
    return;
  }
  const m = project.music?.find((x) => x.id === activeMusicId);
  if (!m) {
    activeMusicId = null;
    el.musicInspector.hidden = true;
    return;
  }
  el.musicInspector.hidden = false;
  el.musicInspectorTitle.textContent = m.name;
  el.musicInspectorKind.textContent = m.kind === "bed" ? "背景" : "过场";
  el.musicInspectorKind.className = "music-kind-badge" + (m.kind === "bed" ? " kind-bed" : " kind-stinger");
  el.musicInspectorAnchor.textContent = findAnchorLabel(m);
  const coverage = selectedMusicCoverage;
  const endLabel = document.querySelector('#music-end-label');
  endLabel.textContent = coverage ? `结束 ${fmt(coverage.outputEnd)} · ${coverage.context} ${coverage.side==='inside'?'字内':coverage.side==='before'?'之前':'之后'}${coverage.gap>.05?` ${coverage.gap.toFixed(2)}s`:''}` : '无法定位结束位置';
  document.querySelector('#music-end-jump').disabled = !coverage?.word;
  const anchorClip = project.clips.find(c=>c.id===m.clipId);
  for (const side of ["before","after"]) {
    const button = document.querySelector(`#music-anchor-${side}`);
    button.disabled = !anchorClip?.words.some(w=>w.id===m.wordId);
    const selected = musicAnchorSide(m,anchorClip?.words)===side;
    button.setAttribute("aria-pressed",String(selected)); button.classList.toggle("btn-active",selected);
  }
  const lead=document.querySelector("#music-lead");lead.value=String(m.leadInSec||0);document.querySelector("#music-lead-label").hidden=m.kind!=="bed";
  const region = resolveMusicRegion(m);
  const preview=document.querySelector('#music-entry-preview'),voice=document.querySelector('#music-entry-voice');
  preview.hidden=m.kind!=='bed';const leadSec=Math.min(region.duration,Number(m.leadInSec)||0);
  voice.style.marginLeft=`${Math.min(95,leadSec/Math.max(.1,region.duration)*100)}%`;voice.textContent=`${leadSec.toFixed(1)}s 人声进入 →`;
  const maxDur = Math.max(0.1, Math.round(m.buffer.duration * 10) / 10);
  el.musicIn.max = String(maxDur);
  el.musicOut.max = String(maxDur);
  el.musicIn.value = String(Math.round(region.inPoint * 10) / 10);
  el.musicOut.value = String(Math.round(region.outPoint * 10) / 10);
  el.musicClipLen.textContent = `选区 ${region.duration.toFixed(1)}s / 素材 ${maxDur.toFixed(1)}s`;
  const scale = 1e3;
  el.musicInRange.max = String(scale);
  el.musicOutRange.max = String(scale);
  el.musicInRange.value = String(Math.round(region.inPoint / maxDur * scale));
  el.musicOutRange.value = String(Math.round(region.outPoint / maxDur * scale));
  const leftPct = region.inPoint / maxDur * 100;
  const widthPct = region.duration / maxDur * 100;
  el.musicRegionFill.style.left = `${leftPct}%`;
  el.musicRegionFill.style.width = `${Math.max(0.5, widthPct)}%`;
  const g = Math.max(-36, Math.min(12, m.gainDb));
  el.musicGain.value = String(g);
  el.musicGainVal.textContent = formatPlacementGain(g);
  const fades = resolveMusicFades(m, region.duration);
  el.musicFadeIn.value = String(Math.round(fades.fadeInSec * 10) / 10);
  el.musicFadeOut.value = String(Math.round(fades.fadeOutSec * 10) / 10);
  el.musicFadeHint.textContent = m.kind === "bed" ? `背景默认 ${BED_FADE_IN_DEFAULT} / ${BED_FADE_OUT_DEFAULT}s` : `过场默认 ${STINGER_FADE_IN_DEFAULT} / ${STINGER_FADE_OUT_DEFAULT}s`;
}
function refreshMusicUi() {
  renderTranscript();
  renderMusicInspector();
}
function placeMusicFromLibrary(libraryId, kind, clipId, originalTime, wordId, anchorSide = "before") {
  void (async () => {
    const meta = sfxLibrary.find((x) => x.id === libraryId);
    if (!meta) {
      toast("素材不存在");
      return;
    }
    if (!project || project.clips.length === 0) {
      toast("请先加载人声音频");
      return;
    }
    const buffer = await ensureLibraryBuffer(libraryId);
    if (!buffer) {
      toast("无法解码该素材");
      return;
    }
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip) {
      toast("目标片段不存在");
      return;
    }
    let resolvedWordId = wordId;
    if (!resolvedWordId) {
      const w = wordAtOriginal(clip.words, originalTime);
      resolvedWordId = w?.id;
    }
    const outPoint = Math.round(buffer.duration * 10) / 10;
    const placement = {
      id: nextMusicId(),
      kind,
      name: meta.name,
      libraryId,
      buffer,
      gainDb: kind === "bed" ? BED_GAIN_DB_DEFAULT : STINGER_GAIN_DB_DEFAULT,
      clipId,
      originalTime,
      wordId: resolvedWordId,
      anchorSide,
      inPoint: 0,
      outPoint,
      fadeInSec: kind === "bed" ? BED_FADE_IN_DEFAULT : STINGER_FADE_IN_DEFAULT,
      fadeOutSec: kind === "bed" ? BED_FADE_OUT_DEFAULT : STINGER_FADE_OUT_DEFAULT
    };
    if (!project.music) project.music = [];
    project.music.push(placement);
    scheduleDraftSave();
    activeMusicId = placement.id;
    syncEngineFromProject();
    refreshMusicUi();
    syncChrome();
    toast(
      kind === "bed" ? `已铺背景「${meta.name}」（叠在人声下）` : `已插入过场「${meta.name}」（不盖人声）`
    );
  })();
}
function removeMusic(id) {
  if (!project?.music) return;
  const idx = project.music.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const name = project.music[idx].name;
  project.music.splice(idx, 1);
  if (activeMusicId === id) activeMusicId = null;
  syncEngineFromProject();
  refreshMusicUi();
  syncChrome();
  toast(`已移除「${name}」`);
}
function selectMusic(id) {
  activePause=null; window.getSelection()?.removeAllRanges();
  activeMusicId = id && activeMusicId === id ? null : id;
  refreshMusicUi();
  if (activeMusicId && project?.music) {
    const m = project.music.find((x) => x.id === id);
    if (m) {
      const region = resolveMusicRegion(m);
      toast(
        `已选中「${m.name}」· ${formatPlacementGain(m.gainDb)} · ${region.inPoint.toFixed(1)}–${region.outPoint.toFixed(1)}s`,
        2200
      );
    }
  }
}
function applyActiveMusicGain(db) {
  if (!project?.music || !activeMusicId) return;
  const m = project.music.find((x) => x.id === activeMusicId);
  if (!m) return;
  m.gainDb = Math.max(-36, Math.min(12, Math.round(db * 2) / 2));
  syncEngineFromProject();
  renderMusicInspector();
  for (const chip of el.transcript.querySelectorAll(".music-chip")) {
    chip.classList.toggle("active", chip.dataset.musicId === activeMusicId);
    if (chip.dataset.musicId === m.id) {
      const region = resolveMusicRegion(m);
      chip.title = `${m.kind === "bed" ? "背景" : "过场"}「${m.name}」· ${formatPlacementGain(m.gainDb)} · ${region.inPoint.toFixed(1)}–${region.outPoint.toFixed(1)}s · 点击选中`;
    }
  }
}
function applyActiveMusicRegion(inSec, outSec) {
  if (!project?.music || !activeMusicId) return;
  const m = project.music.find((x) => x.id === activeMusicId);
  if (!m) return;
  const maxDur = Math.max(0.1, m.buffer.duration);
  let inPoint = Math.max(0, Math.min(maxDur, Math.round(inSec * 10) / 10));
  let outPoint = Math.max(0, Math.min(maxDur, Math.round(outSec * 10) / 10));
  if (outPoint < inPoint) {
    const swap = inPoint;
    inPoint = outPoint;
    outPoint = swap;
  }
  if (outPoint - inPoint < 0.1) {
    outPoint = Math.min(maxDur, inPoint + 0.1);
    if (outPoint - inPoint < 0.1) inPoint = Math.max(0, outPoint - 0.1);
  }
  m.inPoint = inPoint;
  m.outPoint = outPoint;
  syncEngineFromProject();
  refreshMusicUi();
}
function projectTimeForMusic(m) {
  if (!project) return 0;
  for (const clip of project.clips) ensureAudioOrder(clip);
  const scheduleClips = project.clips.map((c) => ({
    id: c.id,
    buffer: c.buffer,
    ranges: c.ranges,
    words: c.words,
    gainDb: c.gainDb ?? 0
  }));
  const mix = buildMixSchedule(
    scheduleClips,
    project.music ?? [],
    dbToLinear(project.gainDb)
  );
  const src = mix.sources.find((s) => s.placementId === m.id);
  return src?.whenEdit ?? 0;
}
let fadePreviewTimer = 0;
function applyActiveMusicFades(fadeInSec, fadeOutSec, opts) {
  if (!project?.music || !activeMusicId) return;
  const m = project.music.find((x) => x.id === activeMusicId);
  if (!m) return;
  const region = resolveMusicRegion(m);
  const maxFade = Math.max(0, region.duration);
  let fi = Number.isFinite(fadeInSec) ? fadeInSec : 0;
  let fo = Number.isFinite(fadeOutSec) ? fadeOutSec : 0;
  fi = Math.max(0, Math.min(30, Math.round(fi * 10) / 10));
  fo = Math.max(0, Math.min(30, Math.round(fo * 10) / 10));
  if (fi > maxFade) fi = Math.round(maxFade * 10) / 10;
  if (fo > maxFade) fo = Math.round(maxFade * 10) / 10;
  const same = Math.abs((m.fadeInSec ?? -1) - fi) < 1e-6 && Math.abs((m.fadeOutSec ?? -1) - fo) < 1e-6;
  if (same && !opts?.preview) return;
  m.fadeInSec = fi;
  m.fadeOutSec = fo;
  const applied = resolveMusicFades(m, region.duration);
  const preview = opts?.preview === true;
  syncEngineFromProject({ resume: false });
  renderMusicInspector();
  const startAt = projectTimeForMusic(m);
  const playPreview = () => {
    engine.play(startAt);
    toast(
      `已应用渐入 ${applied.fadeInSec.toFixed(1)}s · 渐出 ${applied.fadeOutSec.toFixed(1)}s（从该段起点试听）`,
      2800
    );
  };
  if (preview) {
    window.clearTimeout(fadePreviewTimer);
    playPreview();
  } else {
    window.clearTimeout(fadePreviewTimer);
    fadePreviewTimer = window.setTimeout(playPreview, 280);
  }
}
function adjustActiveMusicGain(deltaDb) {
  if (!project?.music || !activeMusicId) return;
  const m = project.music.find((x) => x.id === activeMusicId);
  if (!m) return;
  applyActiveMusicGain(m.gainDb + deltaDb);
  toast(`「${m.name}」${formatPlacementGain(m.gainDb)}`);
}
document.querySelector("#btn-align-clip").addEventListener("click", () => {
  if (boundarySaveTimer) saveWordBoundary();
  for (const clip of project?.clips ?? []) void queueClipAlignment(clip);
});
document.querySelector("#btn-cancel-alignment").addEventListener("click", () => {
  for (const [id, controller] of alignmentJobs) { alignmentMessages.set(id, "已取消，原字界保留"); controller.abort(); } syncAlignmentUi();
});
el.demo.addEventListener("click", () => void loadDemo());
el.upload.addEventListener("click", () => el.file.click());
el.clear.addEventListener("click", () => clearProject());
el.file.addEventListener("change", () => {
  if (el.file.files && el.file.files.length > 0) {
    void loadAudioFiles(el.file.files);
  }
  el.file.value = "";
});
el.urlBtn.addEventListener("click", () => void loadFromPublicUrl(el.audioUrl.value));
el.audioUrl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    void loadFromPublicUrl(el.audioUrl.value);
  }
});
el.play.addEventListener("click", () => {
  stopAudition();
  togglePlayPause();
});
el.pause.addEventListener("click", () => {
  stopAudition();
  engine.pause();
  syncChrome();
});
el.removePauses.addEventListener("click", (ev) => removePauses(ev));
el.detectDup.addEventListener("click", () => void runDetectDuplicates());
el.clearDup.addEventListener("click", () => clearDupFlags());
document.querySelector('#playback-speed').addEventListener('keydown',ev=>{
  if(ev.key==='Enter'){ev.preventDefault();ev.stopPropagation();void applySpeechRate(ev.target);ev.target.blur();}
  if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();ev.target.value=String(engine.getPlaybackRate());ev.target.blur();}
});
async function applySpeechRate(input){
  if(input.disabled)return;
  const rate=input.valueAsNumber;
  if(!Number.isFinite(rate)||rate<.5||rate>2){
    input.value=String(engine.getPlaybackRate());toast('请输入 0.5–2 之间的倍速，例如 1.1 或 1.15');return;
  }
  if(rate===engine.getPlaybackRate())return;
  input.disabled=true;
  try{await engine.setPlaybackRate(rate);input.value=String(engine.getPlaybackRate());if(project){project.speechRate=engine.getPlaybackRate();scheduleDraftSave();}refreshMusicUi();toast(`${input.value}× 人声 · 不变调，音乐原速`);}
  catch(e){input.value=String(engine.getPlaybackRate());toast(`倍速未启用：${e.message}`,4500);}
  finally{input.disabled=false;syncChrome();}
}
for(const event of ['change','blur'])document.querySelector('#playback-speed').addEventListener(event,ev=>void applySpeechRate(ev.target));
document.querySelector('#music-end-jump').addEventListener('click',()=>{
  const coverage=selectedMusicCoverage;
  if(!coverage?.word)return;
  el.transcript.querySelector(`[data-id="${CSS.escape(coverage.word.id)}"]`)?.scrollIntoView({behavior:'smooth',block:'end'});
  engine.seek(Math.max(0,coverage.end-2));
});
el.undo.addEventListener("click", () => doUndo());
el.redo.addEventListener("click", () => doRedo());
el.denoise.addEventListener("click", () => void toggleDenoise());
el.beautify.addEventListener("click", () => void toggleBeautify());
el.deleteSel.addEventListener("pointerdown", ev => ev.preventDefault());
el.copySel?.addEventListener("pointerdown", ev => ev.preventDefault());
el.deleteSel.addEventListener("click", () => {
  if (activePause) { deleteSelectedPause(); return; }
  const ids = idsForDelete();
  if (ids.size === 0) {
    toast("先单击或拖选要删的字，再点删除");
    return;
  }
  deleteWordsByIds(ids);
  window.getSelection()?.removeAllRanges();
  setActiveHighlight(null);
  syncSelectionBar();
});
el.restoreSel.addEventListener("pointerdown", ev => ev.preventDefault());
el.restoreSel.addEventListener("click", () => {
  if (activePause) { restoreSelectedPause(); return; }
  const ids = selectedDeletedWordIds();
  if (ids.size === 0) {
    toast("先选中已删除的字，再点复原");
    return;
  }
  restoreWordsByIds(ids);
  window.getSelection()?.removeAllRanges();
  syncSelectionBar();
});
el.copySel.addEventListener("click", () => {
  copySelectedWords();
});
el.pasteWords.addEventListener("click", () => {
  pasteWordsAtAnchor();
});
el.pasteStart.addEventListener("click", () => {
  pasteWordsAtStart();
});
el.threshold.addEventListener("input", () => {
  thresholdSec = Number(el.threshold.value);
  try { localStorage.setItem("podcut.pauseThreshold",String(thresholdSec)); } catch {}
  el.thresholdVal.textContent = `${thresholdSec.toFixed(2)}s`;
  updatePauseSummary();
});
el.gain.addEventListener("input", () => {
  const clip = getActiveClip();
  if (!clip) return;
  clip.gainDb = clampGainDb(Number(el.gain.value));
  syncGainUi(clip.gainDb);
  syncEngineFromProject();
  scheduleDraftSave();
});
el.gain.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
  },
  { passive: false }
);
el.exportTxt.addEventListener("click", () => {
  if (!project) return;
  exportMultiTxt(project.clips, `${project.audioName}-transcript`);
  toast("已导出 .txt");
});
el.exportMd.addEventListener("click", () => {
  if (!project) return;
  exportMultiMd(project.clips, `${project.audioName}-transcript`);
  toast("已导出 .md");
});
let exportBusy=false, exportPoll=0;
const lastAudioDownload = $("#download-last-audio");
function showExportNotice(message, ongoing = false, link) {
  toolbarNotice.show(message, { duration: ongoing ? 0 : 5000, link });
}
function showExportJob(job,autoDownload=false){
  if(job.error){exportBusy=false;showExportNotice(`导出失败：${job.error}`);syncChrome();return;}
  if(job.done){
    exportBusy=false;
    lastAudioDownload.href=job.download;
    lastAudioDownload.download=`${project?.audioName??'podcast'}-edited.wav`;
    lastAudioDownload.hidden=false;
    showExportNotice('音频已生成并保存在本机', false, {
      href: job.download, download: lastAudioDownload.download,
      label: `下载 WAV（${Math.round((job.bytes??0)/1024/1024)} MB）`
    });
    syncChrome();if(autoDownload)lastAudioDownload.click();return;
  }
  exportBusy=true;showExportNotice(`${job.stage} · ${job.percent}%（本机后台处理）`,true);el.exportAudio.disabled=true;
  window.clearTimeout(exportPoll);exportPoll=window.setTimeout(async()=>{try{const next=await localExportStatus(job.id);if(next)showExportJob(next,autoDownload);}catch(e){showExportNotice('正在重连导出进度，本机任务仍在继续…',true);exportPoll=window.setTimeout(()=>showExportJob(job,autoDownload),4000);}},1500);
}
el.exportAudio.addEventListener("click", async () => {
  if (!project || project.clips.length === 0 || exportBusy) return;
  exportBusy=true;el.exportAudio.disabled=true;showExportNotice('正在保存本次剪辑…',true);
  try {
    for(const clip of project.clips)ensureAudioOrder(clip);
    scheduleDraftSave();window.clearTimeout(draftSaveTimer);
    if(!await flushDraftSave({toastFail:true}))throw Error('请先完成草稿保存');
    if(draftStorageKind()==='disk'){
      const job=await startLocalExport(draftRevision());if(!job)throw Error('未能创建导出任务');showExportJob(job,true);return;
    }
    // Hosted short projects retain browser export; avoid crashing long projects.
    const duration=project.clips.reduce((n,c)=>n+c.ranges.reduce((v,r)=>v+r.end-r.start,0),0);
    if(duration>600)throw Error('整期音频需要本机导出服务，请从本机地址打开工程');
    showExportNotice('正在生成 WAV…',true);
    const scheduleClips=project.clips.map(c=>({id:c.id,buffer:c.buffer,ranges:c.ranges,words:c.words,gainDb:c.gainDb??0}));
    const blob=await exportMixedWav(scheduleClips,project.music??[],dbToLinear(project.gainDb),project.speechRate??1,engine.getRenderSampleRate());
    downloadBlob(blob,`${project.audioName}-edited.wav`);exportBusy=false;showExportNotice('WAV 已生成，已请求浏览器下载');
  } catch(e){exportBusy=false;showExportNotice(`导出失败：${e instanceof Error?e.message:String(e)}`);}
  finally{syncChrome();if(exportBusy)el.exportAudio.disabled=true;}
});
// Recover progress / completed download after a tab reload. No project mutation.
if(['127.0.0.1','localhost','[::1]'].includes(location.hostname))void latestLocalExport().then(job=>{if(job)showExportJob(job);}).catch(()=>{});
/** Pointer selections snap to the same word IDs that Delete will consume. */
let transcriptDrag = { active:false, moved:false, x:0, y:0, anchor:null, last:null };
let selectionAnchorId=null;
el.transcript.addEventListener("pointerdown", (ev) => {
  if(ev.button!==0)return;
  const word=ev.target.closest?.(".word");
  transcriptDrag={active:false,moved:false,x:ev.clientX,y:ev.clientY,anchor:null,last:null};
  if(!word || ev.pointerType==="touch")return;
  ev.preventDefault();
  if(activePause)closeWordAudioRail();
  activePause=null;activeMusicId=null;setActiveHighlight(null);renderMusicInspector();
  const anchor=ev.shiftKey && selectionAnchorId ? el.transcript.querySelector(`.word[data-id="${CSS.escape(selectionAnchorId)}"]`)??word : word;
  if(!ev.shiftKey)selectionAnchorId=word.dataset.id;
  transcriptDrag={active:true,moved:ev.shiftKey,x:ev.clientX,y:ev.clientY,anchor,last:word};
  selectWordSpan(el.transcript,anchor,word);syncSelectionBar();
});
window.addEventListener("pointermove", ev=>{
  const drag=transcriptDrag;if(!drag.active)return;
  if(Math.hypot(ev.clientX-drag.x,ev.clientY-drag.y)>3)drag.moved=true;
  if(!drag.moved)return;
  let word=document.elementFromPoint(ev.clientX,ev.clientY)?.closest(".word");
  if(!word) {
    const caret=document.caretRangeFromPoint?.(ev.clientX,ev.clientY);
    word=caret?.startContainer?.parentElement?.closest(".word");
  }
  if(word && el.transcript.contains(word) && word!==drag.last) {
    drag.last=word;selectWordSpan(el.transcript,drag.anchor,word);syncSelectionBar();
  }
  const canvas=document.querySelector(".canvas"), rect=canvas.getBoundingClientRect();
  if(ev.clientY>rect.bottom-30)canvas.scrollBy(0,18);else if(ev.clientY<rect.top+30)canvas.scrollBy(0,-18);
});
window.addEventListener("pointerup",()=>{transcriptDrag.active=false;});
window.addEventListener("pointercancel",()=>{transcriptDrag.active=false;});
el.transcript.addEventListener("click", (ev) => {
  const speakerLabel=ev.target.closest('button.speaker-label');
  if(speakerLabel){
    ev.preventDefault(); setActiveClip(speakerLabel.dataset.clipId);
    const group=document.querySelector('#speaker-group'); group.open=true;
    group.querySelector(`input[data-speaker-id="${CSS.escape(speakerLabel.dataset.speakerId)}"]`)?.focus({preventScroll:true});
    return;
  }
  // An explicit insertion cursor takes precedence over any previous text selection.
  const caret = ev.target.closest(".paste-caret");
  if (caret?.dataset.clipId && caret.dataset.wordId && project) {
    ev.preventDefault();
    transcriptDrag.moved = false;
    window.getSelection()?.removeAllRanges();
    const clipIndex = project.clips.findIndex(c => c.id === caret.dataset.clipId);
    const clip = project.clips[clipIndex];
    const word = clip?.words.find(w => w.id === caret.dataset.wordId);
    if (!word) return;
    setActiveClip(clip.id);
    activeMusicId=null; renderMusicInspector();
    engine.seekClipStart(clipIndex);
    setActiveHighlight(word.id, "before");
    el.transcript.focus({preventScroll:true});
    syncChrome();
    toast("光标在开头：粘贴会插到第一个字前面");
    return;
  }
  // Preserve the browser's multi-character selection after dragging.
  if (transcriptDrag.moved) {
    transcriptDrag.moved = false;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && (el.transcript.contains(sel.anchorNode) || el.transcript.contains(sel.focusNode))) {
      el.transcript.focus({ preventScroll: true });
      syncSelectionBar();
      return;
    }
  }
  const editPause = ev.target.closest(".pause-edit");
  if(editPause) {ev.preventDefault();openPauseAudioRail(editPause.dataset.clipId,editPause.dataset.pauseId,editPause.dataset.cleared==="true");return;}
  const pendingPause = ev.target.closest(".mark-pause");
  if (pendingPause?.dataset.clipId) {
    ev.preventDefault(); ev.stopPropagation();
    openPauseAudioRail(pendingPause.dataset.clipId, pendingPause.dataset.pauseId, false);
    deleteSelectedPause();
    return;
  }
  const pauseMark = ev.target.closest(".mark-pause-cleared");
  if (pauseMark?.dataset.clipId && pauseMark.dataset.pauseId) {
    ev.preventDefault();
    ev.stopPropagation();
    openPauseAudioRail(pauseMark.dataset.clipId, pauseMark.dataset.pauseId, true);
    restoreSelectedPause();
    return;
  }
  const chip = ev.target.closest(".music-chip");
  if (chip?.dataset.musicId) {
    if(Date.now()<suppressMusicClickUntil)return;
    ev.preventDefault();
    ev.stopPropagation();
    selectMusic(chip.dataset.musicId);
    return;
  }
  const target = ev.target.closest(".word");
  if (!target || !project) {
    if (activeMusicId && !ev.target.closest(".music-inspector")) {
      selectMusic(null);
    }
    return;
  }
  const id = target.dataset.id;
  const clipId = target.dataset.clipId;
  if (!id || !clipId) return;
  const clipIndex = project.clips.findIndex((c) => c.id === clipId);
  const clip = project.clips[clipIndex];
  if (!clip) return;
  const word = clip.words.find((w) => w.id === id);
  if (!word) return;
  const rect = target.getBoundingClientRect();
  const side = ev.clientX < rect.left + rect.width * 0.45 ? "before" : "after";
  setActiveClip(clipId);
  engine.seekOriginal(clipIndex, word.start);
  openWordAudioRail(clipId, id);
  // Single click selects the word for Delete/Cmd+C and exposes its waveform.
  if (!word.deleted) {
    setActiveHighlight(word.id, side);
    selectWordElement(target);
  } else {
    setActiveHighlight(null);
    selectWordElement(target);
  }
  syncChrome();

});
el.transcript.addEventListener("mouseup", () => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && (el.transcript.contains(sel.anchorNode) || el.transcript.contains(sel.focusNode))) {
    el.transcript.focus({ preventScroll: true });
  }
});
el.track.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-act]");
  const block = ev.target.closest(".track-block");
  // B4: retry / dismiss failed ASR job
  if (block?.dataset.jobId && btn) {
    const jobId = block.dataset.jobId;
    const act = btn.dataset.act;
    ev.stopPropagation();
    const job = asrJobs.find((j) => j.id === jobId);
    if (!job) return;
    if (act === "dismiss-job") {
      try {
        job.controller?.abort("dismissed");
      } catch {
        /* */
      }
      removeAsrJob(jobId);
      renderTrack();
      syncChrome();
      ensureImportControlsEnabled();
      return;
    }
    if (act === "retry-job") {
      job.status = "queued";
      job.progress = 0;
      job.error = null;
      job.controller = new AbortController();
      renderTrack();
      kickImportWatchdog();
      ensureImportControlsEnabled();
      void pumpAsrQueue();
      return;
    }
    return;
  }
  if (!block?.dataset.clipId) return;
  const id = block.dataset.clipId;
  if (btn) {
    const act = btn.dataset.act;
    ev.stopPropagation();
    if (act === "up") moveClip(id, -1);
    else if (act === "down") moveClip(id, 1);
    else if (act === "remove") removeClip(id);
    return;
  }
  setActiveClip(id);
  const idx = project?.clips.findIndex((c) => c.id === id) ?? -1;
  if (idx >= 0) {
    engine.seek(engine.speechEditToProject(engine.clipEditOffset(idx)));
    const section = el.transcript.querySelector(`[data-clip-id="${CSS.escape(id)}"]`);
    section?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  syncChrome();
});
el.track.addEventListener("dragstart", (ev) => {
  const block = ev.target.closest(".track-block");
  if (!block?.dataset.clipId || block.dataset.jobId || !(ev instanceof DragEvent)) return;
  dragClipId = block.dataset.clipId;
  block.classList.add("dragging");
  ev.dataTransfer?.setData("text/plain", dragClipId);
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
});
el.track.addEventListener("dragend", () => {
  dragClipId = null;
  for (const n of el.track.querySelectorAll(".track-block.dragging, .track-block.drag-over")) {
    n.classList.remove("dragging", "drag-over");
  }
});
el.track.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  const block = ev.target.closest(".track-block");
  for (const n of el.track.querySelectorAll(".track-block.drag-over")) {
    n.classList.remove("drag-over");
  }
  if (block && block.dataset.clipId !== dragClipId) {
    block.classList.add("drag-over");
  }
  if (ev instanceof DragEvent && ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
});
el.track.addEventListener("drop", (ev) => {
  ev.preventDefault();
  const block = ev.target.closest(".track-block");
  const fromId = dragClipId || (ev instanceof DragEvent ? ev.dataTransfer?.getData("text/plain") : "");
  const toId = block?.dataset.clipId;
  for (const n of el.track.querySelectorAll(".track-block.drag-over")) {
    n.classList.remove("drag-over");
  }
  if (!fromId || !toId || fromId === toId) return;
  if (!project) return;
  const fromIdx = project.clips.findIndex((c) => c.id === fromId);
  const toIdx = project.clips.findIndex((c) => c.id === toId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = project.clips.splice(fromIdx, 1);
  const newTo = project.clips.findIndex((c) => c.id === toId);
  project.clips.splice(newTo, 0, moved);
  activeClipId = fromId;
  refreshAfterClipsChange();
  toast("已调整轨道顺序");
});
function isTypingTarget(t) {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable;
}
function togglePlayPause() {
  stopAudition();
  if (!project || project.clips.length === 0) return;
  if (engine.isPlaying()) {
    engine.pause();
    syncChrome();
    return;
  }
  const from = engine.getEditTime() >= engine.getEditDuration() - 0.05 ? 0 : engine.getEditTime();
  engine.play(from);
  syncChrome();
}
function handleEditKeys(ev) {
  if(ev.target instanceof Element && ev.target.closest("dialog"))return;
  if ((ev.key === "Delete" || ev.key === "Backspace") && activePause && !isTypingTarget(ev.target)) { ev.preventDefault(); deleteSelectedPause(); return; }
  if (ev.key === "Escape") stopAudition();
  if ((ev.key === "Backspace" || ev.key === "Delete") && activeMusicId) {
    const wordIds = selectedWordIds();
    if (wordIds.size === 0 && !isTypingTarget(ev.target)) {
      if (project?.music?.some((m) => m.id === activeMusicId)) {
        ev.preventDefault();
        removeMusic(activeMusicId);
        return;
      }
    }
  }
  if (ev.key === "[" && activeMusicId && !isTypingTarget(ev.target)) {
    ev.preventDefault();
    adjustActiveMusicGain(-1);
    return;
  }
  if (ev.key === "]" && activeMusicId && !isTypingTarget(ev.target)) {
    ev.preventDefault();
    adjustActiveMusicGain(1);
    return;
  }
  if (ev.key === "Backspace" || ev.key === "Delete") {
    if (isTypingTarget(ev.target)) return;
    const ids = idsForDelete();
    if (ids.size === 0) return;
    // User intent wins: click-focus or drag-select both delete (no DOM-selection gate).
    ev.preventDefault();
    deleteWordsByIds(ids);
    window.getSelection()?.removeAllRanges();
    setActiveHighlight(null);
    syncSelectionBar();
    el.transcript.focus({ preventScroll: true });
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "c") {
    if (isTypingTarget(ev.target)) return;
    const ids = selectedWordIds();
    if (ids.size === 0) return;
    const sel = window.getSelection();
    if (!sel || !el.transcript.contains(sel.anchorNode) && !el.transcript.contains(sel.focusNode)) {
      return;
    }
    ev.preventDefault();
    copySelectedWords();
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "v") {
    if (isTypingTarget(ev.target)) return;
    if (!wordClipboard || !project) return;
    const t = ev.target;
    if (t instanceof Node && !el.transcript.contains(t) && t !== document.body && t !== document.documentElement && !(t instanceof HTMLElement && (t.id === "app" || t.closest?.("#app")))) {
    }
    ev.preventDefault();
    pasteWordsAtAnchor();
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z") {
    if (!project) return;
    if (isTypingTarget(ev.target)) return;
    ev.preventDefault();
    if (ev.shiftKey) doRedo(); else doUndo();
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "y") {
    if (!project || isTypingTarget(ev.target)) return;
    ev.preventDefault(); doRedo(); return;
  }
  if (ev.code === "Space" || ev.key === " ") {
    if (ev.defaultPrevented || isTypingTarget(ev.target)) return;
    if (ev.target.closest?.("button, [role=button], summary") && !ev.target.closest?.(".paste-caret")) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (!project || project.clips.length === 0) return;
    ev.preventDefault();
    if (!ev.repeat) togglePlayPause();
  }
}
function ensureDropUi() {
  let affordance = document.getElementById("sfx-drop-affordance");
  if (!affordance) {
    affordance = document.createElement("div");
    affordance.id = "sfx-drop-affordance";
    affordance.className = "sfx-drop-affordance";
    affordance.hidden = true;
    affordance.setAttribute("aria-hidden", "true");
    document.body.appendChild(affordance);
  }
  let chooser = document.getElementById("sfx-kind-chooser");
  if (!chooser) {
    chooser = document.createElement("div");
    chooser.id = "sfx-kind-chooser";
    chooser.className = "sfx-kind-chooser";
    chooser.hidden = true;
    chooser.innerHTML = `
      <button type="button" class="sfx-kind-btn kind-bed" data-kind="bed">背景</button>
      <button type="button" class="sfx-kind-btn kind-stinger" data-kind="stinger">过场</button>
      <button type="button" class="sfx-kind-btn kind-cancel" data-kind="cancel">取消</button>
    `;
    document.body.appendChild(chooser);
    chooser.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-kind]");
      if (!btn || !pendingDrop) return;
      const kind = btn.dataset.kind;
      const { libId, anchor } = pendingDrop;
      hideKindChooser();
      if (kind === "cancel" || kind !== "bed" && kind !== "stinger") return;
      placeFromAnchor(libId, kind, anchor);
    });
  }
  return { affordance, chooser };
}
function hideKindChooser() {
  pendingDrop = null;
  const { chooser } = ensureDropUi();
  chooser.hidden = true;
}
function showKindChooser(clientX, clientY, libId, anchor) {
  pendingDrop = { libId, anchor };
  const { chooser } = ensureDropUi();
  chooser.hidden = false;
  const pad = 8;
  const w = 200;
  const left = Math.min(window.innerWidth - w - pad, Math.max(pad, clientX - w / 2));
  const top = Math.min(window.innerHeight - 48 - pad, Math.max(pad, clientY + 12));
  chooser.style.left = `${left}px`;
  chooser.style.top = `${top}px`;
}
function clearDropHover() {
  dropAnchor = null;
  const { affordance } = ensureDropUi();
  affordance.hidden = true;
  affordance.classList.remove("is-bed", "is-stinger");
  if (el.transcript) {
    for (const n of el.transcript.querySelectorAll(".word.drop-hover-bed, .word.drop-hover-stinger")) {
      n.classList.remove("drop-hover-bed", "drop-hover-stinger");
    }
    el.transcript.classList.remove("drop-bed", "drop-stinger");
  }
}
function setDropHover(anchor, preferStinger) {
  const { affordance } = ensureDropUi();
  if (dropAnchor?.wordEl) {
    dropAnchor.wordEl.classList.remove("drop-hover-bed", "drop-hover-stinger");
  }
  el.transcript.classList.remove("drop-bed", "drop-stinger");
  dropAnchor = anchor;
  if (!anchor) {
    affordance.hidden = true;
    affordance.classList.remove("is-bed", "is-stinger");
    return;
  }
  const kind = preferStinger ? "stinger" : "bed";
  anchor.wordEl.classList.add(kind === "bed" ? "drop-hover-bed" : "drop-hover-stinger");
  el.transcript.classList.add(kind === "bed" ? "drop-bed" : "drop-stinger");
  const r = anchor.wordEl.getBoundingClientRect();
  const x = anchor.atEnd ? r.right : r.left;
  affordance.hidden = false;
  affordance.classList.toggle("is-bed", kind === "bed");
  affordance.classList.toggle("is-stinger", kind === "stinger");
  affordance.textContent = dragMusicId ? `移动到「${anchor.wordEl.textContent}」${anchor.atEnd ? "字后" : "字前"}` : preferStinger ? "过场 · 松开即插入" : "放下 · 选背景/过场";
  affordance.style.left = `${Math.round(x)}px`;
  affordance.style.top = `${Math.round(r.top)}px`;
}
function wordElFromNode(under) {
  if (!under || !el.transcript.contains(under)) return null;
  const chip = under.closest(".music-chip");
  if (chip) return null;
  const word = under.closest(".word");
  if (word && el.transcript.contains(word) && !word.classList.contains("deleted") && word.dataset.id) {
    return word;
  }
  return null;
}
function nearestWordEl(clientX, clientY) {
  const words = Array.from(
    el.transcript.querySelectorAll(".word:not(.deleted)")
  );
  let best = null;
  let bestDist = Infinity;
  for (const w of words) {
    const r = w.getBoundingClientRect();
    if (clientY < r.top - 10 || clientY > r.bottom + 10) continue;
    const cx = Math.min(Math.max(clientX, r.left), r.right);
    const cy = Math.min(Math.max(clientY, r.top), r.bottom);
    const d = (cx - clientX) ** 2 + (cy - clientY) ** 2;
    if (d < bestDist && d <= 48 * 48) {
      bestDist = d;
      best = w;
    }
  }
  return best;
}
function resolveDropAnchor(clientX, clientY, eventTarget) {
  let wordEl = eventTarget instanceof HTMLElement ? wordElFromNode(eventTarget) : null;
  if (!wordEl) {
    const under = document.elementFromPoint(clientX, clientY);
    wordEl = wordElFromNode(under) ?? nearestWordEl(clientX, clientY);
  }
  if (!wordEl?.dataset.id || !wordEl.dataset.clipId) return null;
  const r = wordEl.getBoundingClientRect();
  const atEnd = clientX >= r.left + r.width * 0.55;
  return {
    clipId: wordEl.dataset.clipId,
    wordId: wordEl.dataset.id,
    atEnd,
    wordEl
  };
}
function placeFromAnchor(libId, kind, anchor) {
  if (!project) return;
  const clip = project.clips.find((c) => c.id === anchor.clipId);
  const w = clip?.words.find((x) => x.id === anchor.wordId);
  if (!clip || !w) {
    toast("无法定位投放点");
    return;
  }
  const originalTime = anchor.atEnd ? w.end : w.start;
  placeMusicFromLibrary(libId, kind, clip.id, originalTime, w.id, anchor.atEnd ? "after" : "before");
}
el.sfxAdd.addEventListener("click", () => el.sfxFile.click());
document.querySelector('#btn-sfx-url').addEventListener('click', () => void loadSfxFromUrl());
document.querySelector('#sfx-audio-url').addEventListener('input', () => { document.querySelector('#sfx-url-status').hidden = true; });
document.querySelector('#sfx-audio-url').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); void loadSfxFromUrl(); }
});
el.sfxDemo.addEventListener("click", () => {
  void (async () => {
    el.sfxDemo.disabled = true;
    try {
      const n = await importDemoSfx();
      if (n === 0) toast("演示配乐已在库中（科技开场 / 过场 / 结尾）");
      else toast(`已导入 ${n} 条演示配乐`);
    } finally {
      el.sfxDemo.disabled = false;
    }
  })();
});
el.sfxFile.addEventListener("change", () => {
  if (el.sfxFile.files && el.sfxFile.files.length > 0) {
    void addSfxFiles(el.sfxFile.files);
  }
  el.sfxFile.value = "";
});
el.sfxList.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-sfx-act]");
  const card = ev.target.closest(".sfx-card");
  if (!btn || !card?.dataset.libraryId) return;
  const id = card.dataset.libraryId;
  const act = btn.dataset.sfxAct;
  ev.stopPropagation();
  void (async () => {
    if (act === "del") {
      await deleteSfxFromLibrary(id);
      libraryBuffers.delete(id);
      await refreshSfxLibrary();
      toast("已从常用音频删除");
      return;
    }
    if (act === "rename") {
      const cur = sfxLibrary.find((x) => x.id === id);
      const name = window.prompt("重命名", cur?.name ?? "");
      if (!name || !name.trim()) return;
      await updateSfxMeta(id, { name: name.trim() });
      await refreshSfxLibrary();
      return;
    }
    if (act === "tag") {
      const cur = sfxLibrary.find((x) => x.id === id);
      const next = window.prompt(
        `标签（${SFX_TAGS.join(" / ")}）`,
        cur?.tag ?? "过场"
      );
      if (!next) return;
      const tag = SFX_TAGS.includes(next) ? next : "自定义";
      await updateSfxMeta(id, { tag });
      await refreshSfxLibrary();
    }
  })();
});
el.sfxList.addEventListener("dragstart", (ev) => {
  const card = ev.target.closest(".sfx-card");
  if (!card?.dataset.libraryId || !(ev instanceof DragEvent)) return;
  hideKindChooser();
  dragLibraryId = card.dataset.libraryId;
  card.classList.add("dragging");
  ev.dataTransfer?.setData("application/x-podcast-sfx", dragLibraryId);
  ev.dataTransfer?.setData("text/plain", dragLibraryId);
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
  el.transcript.classList.add("sfx-dragging");
  ensureDropUi();
});
el.sfxList.addEventListener("dragend", () => {
  dragLibraryId = null;
  for (const n of el.sfxList.querySelectorAll(".sfx-card.dragging")) {
    n.classList.remove("dragging");
  }
  el.transcript.classList.remove("sfx-dragging", "drop-bed", "drop-stinger");
  clearDropHover();
});
el.transcript.addEventListener("dragover", (ev) => {
  const types = ev instanceof DragEvent ? Array.from(ev.dataTransfer?.types ?? []) : [];
  // Only treat as SFX drop when we started a library drag (or explicit MIME).
  // Do NOT treat plain text/selection drags as music drops (PM FYI).
  const isSfx =
    !!dragMusicId || types.includes("application/x-podcast-placement") || !!dragLibraryId || types.includes("application/x-podcast-sfx");
  if (!isSfx) return;
  ev.preventDefault();
  if (!(ev instanceof DragEvent)) return;
  el.transcript.classList.add("sfx-dragging");
  const anchor = resolveDropAnchor(ev.clientX, ev.clientY, ev.target);
  if (anchor) {
    setDropHover(anchor, dragMusicId ? project.music.find(m=>m.id===dragMusicId)?.kind==="stinger" : ev.shiftKey);
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = dragMusicId ? "move" : "copy";
  } else {
    setDropHover(null, false);
  }
});
el.transcript.addEventListener("dragleave", (ev) => {
  if (!(ev instanceof DragEvent)) return;
  const next = ev.relatedTarget;
  if (next && el.transcript.contains(next)) return;
  clearDropHover();
});
el.transcript.addEventListener("drop", (ev) => {
  if (!(ev instanceof DragEvent)) return;
  const types = Array.from(ev.dataTransfer?.types ?? []);
  const isSfx =
    !!dragMusicId || types.includes("application/x-podcast-placement") || !!dragLibraryId || types.includes("application/x-podcast-sfx");
  // Ignore text-selection drops so drag-select never opens bed/stinger UI.
  if (!isSfx) return;
  ev.preventDefault();
  const libId =
    dragLibraryId ||
    ev.dataTransfer?.getData("application/x-podcast-sfx") ||
    "";
  const anchor = resolveDropAnchor(ev.clientX, ev.clientY, ev.target) ?? dropAnchor;
  const shift = ev.shiftKey;
  el.transcript.classList.remove("sfx-dragging", "drop-bed", "drop-stinger");
  clearDropHover();
  const movingId=dragMusicId || ev.dataTransfer?.getData("application/x-podcast-placement");
  if (movingId) { if(anchor) moveMusicToAnchor(movingId,anchor); return; }
  if (!libId || !project) return;
  if (!anchor) {
    toast("请拖到文字上放置");
    return;
  }
  if (shift) {
    placeFromAnchor(libId, "stinger", anchor);
    return;
  }
  showKindChooser(ev.clientX, ev.clientY, libId, {
    clipId: anchor.clipId,
    wordId: anchor.wordId,
    atEnd: anchor.atEnd,
    wordEl: anchor.wordEl
  });
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && pendingDrop) {
    hideKindChooser();
  }
});
document.addEventListener("pointerdown", (ev) => {
  if (!pendingDrop) return;
  const { chooser } = ensureDropUi();
  if (chooser.hidden) return;
  if (ev.target instanceof Node && chooser.contains(ev.target)) return;
  hideKindChooser();
});
el.musicGain.addEventListener("input", () => {
  const db = Number(el.musicGain.value);
  el.musicGainVal.textContent = formatPlacementGain(db);
  applyActiveMusicGain(db);
});
el.musicGain.addEventListener("wheel", (ev) => ev.preventDefault(), { passive: false });
function readMusicRegionFromInputs() {
  return {
    inSec: Number(el.musicIn.value),
    outSec: Number(el.musicOut.value)
  };
}
el.musicIn.addEventListener("change", () => {
  const { inSec, outSec } = readMusicRegionFromInputs();
  applyActiveMusicRegion(inSec, outSec);
});
el.musicOut.addEventListener("change", () => {
  const { inSec, outSec } = readMusicRegionFromInputs();
  applyActiveMusicRegion(inSec, outSec);
});
el.musicIn.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    ev.target.blur();
  }
});
el.musicOut.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    ev.target.blur();
  }
});
function regionFromRangeSlider(which) {
  if (!project?.music || !activeMusicId) return;
  const m = project.music.find((x) => x.id === activeMusicId);
  if (!m) return;
  const maxDur = Math.max(0.1, m.buffer.duration);
  const scale = Number(el.musicInRange.max) || 1e3;
  let inSec = Number(el.musicInRange.value) / scale * maxDur;
  let outSec = Number(el.musicOutRange.value) / scale * maxDur;
  if (which === "in" && inSec > outSec - 0.1) inSec = Math.max(0, outSec - 0.1);
  if (which === "out" && outSec < inSec + 0.1) outSec = Math.min(maxDur, inSec + 0.1);
  applyActiveMusicRegion(inSec, outSec);
}
el.musicInRange.addEventListener("input", () => regionFromRangeSlider("in"));
el.musicOutRange.addEventListener("input", () => regionFromRangeSlider("out"));
el.musicInRange.addEventListener("wheel", (ev) => ev.preventDefault(), { passive: false });
el.musicOutRange.addEventListener("wheel", (ev) => ev.preventDefault(), { passive: false });
el.musicFadeIn.addEventListener("change", () => {
  applyActiveMusicFades(Number(el.musicFadeIn.value), Number(el.musicFadeOut.value), {
    preview: true
  });
});
el.musicFadeOut.addEventListener("change", () => {
  applyActiveMusicFades(Number(el.musicFadeIn.value), Number(el.musicFadeOut.value), {
    preview: true
  });
});
el.musicFadeIn.addEventListener("input", () => {
  applyActiveMusicFades(Number(el.musicFadeIn.value), Number(el.musicFadeOut.value), {
    preview: false
  });
});
el.musicFadeOut.addEventListener("input", () => {
  applyActiveMusicFades(Number(el.musicFadeIn.value), Number(el.musicFadeOut.value), {
    preview: false
  });
});
el.musicFadeIn.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    ev.target.blur();
  }
});
el.musicFadeOut.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    ev.target.blur();
  }
});
document.querySelector("#btn-music-close").addEventListener("click",()=>selectMusic(null));
el.musicRemove.addEventListener("click", () => {
  if (activeMusicId) removeMusic(activeMusicId);
});
document.addEventListener("keydown", handleEditKeys);
// Native Edit > Copy / browser menu shortcuts may dispatch copy without keydown.
document.addEventListener("copy", (ev) => {
  if (isTypingTarget(ev.target)) return;
  const sel = window.getSelection();
  if (!sel || (!el.transcript.contains(sel.anchorNode) && !el.transcript.contains(sel.focusNode))) return;
  if (!copySelectedWords()) return;
  ev.clipboardData?.setData("text/plain", wordClipboard.plainText);
  ev.preventDefault();
});
window.__cutter = {
  engine,
  getProject: () => project,
  buildTranscriptText: () => project ? buildMultiClipTranscript(project.clips) : "",
  deleteFirstWord: () => {
    if (!project) return false;
    for (const c of project.clips) {
      const w = c.words.find((x) => !x.deleted);
      if (w) {
        deleteWordsByIds(new Set([w.id]));
        return true;
      }
    }
    return false;
  }
};
document.querySelector("#draft-status").addEventListener("click", () => {
  if (!project?.clips.length) return;
  scheduleDraftSave(); void flushDraftSave({toastOk:true});
});



el.wordRailHLeft.addEventListener("pointerdown", (ev) => {
  if (!wordRailState) return;
  ev.preventDefault();
  wordRailDrag = "left";
  wordRailDragMoved = false;
  el.wordRailHLeft.setPointerCapture?.(ev.pointerId);
});
el.wordRailHRight.addEventListener("pointerdown", (ev) => {
  if (!wordRailState) return;
  ev.preventDefault();
  wordRailDrag = "right";
  wordRailDragMoved = false;
  el.wordRailHRight.setPointerCapture?.(ev.pointerId);
});
let wordRailDragMoved = false;
window.addEventListener("pointermove", (ev) => {
  if (!wordRailDrag || !wordRailState) return;
  wordRailDragMoved = true;
  boundaryEditVersions.set(wordRailState.clipId, (boundaryEditVersions.get(wordRailState.clipId) || 0) + 1);
  const rect = el.wordRailWrap.getBoundingClientRect();
  const sec = railXToSec(ev.clientX - rect.left);
  if (wordRailDrag === "left") {
    wordRailState.selStart = Math.min(sec, wordRailState.selEnd - 0.02);
  } else {
    wordRailState.selEnd = Math.max(sec, wordRailState.selStart + 0.02);
  }
  syncWordRailChrome();
});
window.addEventListener("pointerup", () => {
  const changed = wordRailDrag && wordRailDragMoved;
  wordRailDrag = null;
  if (changed) saveWordBoundary();
});
window.addEventListener("resize", () => {
  syncDrawerBackdrop();
  if (wordRailState) paintWordRailWave();
});

void (async () => {
  ensureImportControlsEnabled();
  try {
    if (navigator.storage && navigator.storage.persist) {
      await navigator.storage.persist();
    }
  } catch {
    /* */
  }
  await refreshSfxLibrary();
  await seedDemoSfxIfEmpty();
  await refreshSfxLibrary();
  try {
    const restored = await tryRestoreDraft();
    if (!restored) syncChrome();
  } finally {
    draftBootReady = true;
    ensureDraftHeartbeat();
    for (const clip of project?.clips ?? []) {
      if (clip.sourceBlob && !clip.words.some(w=>w.alignmentSource) && clip.words.some(w=>!w.manualBoundary && !isPunctText(w.text))) {
        alignmentMessages.set(clip.id,"旧草稿将自动补做逐字校准 · 保留手动字界"); syncAlignmentUi();
        window.setTimeout(()=>{if(project?.clips.includes(clip) && !alignmentJobs.has(clip.id)) void queueClipAlignment(clip);},1500);
      }
    }
  }
  ensureImportControlsEnabled();
})();
function flushDraftOnUnload() {
  if (!draftBootReady) return;
  if (!project || project.clips.length === 0) return;
  // Fire-and-await as long as the tab allows; heartbeat + critical path
  // should already have written. This is a last-chance write.
  void flushDraftSave({ reason: "unload", toastOk: false, toastFail: false });
}
let returningHome = false;
document.querySelector('#btn-home').addEventListener('click', async () => {
  if (returningHome) return;
  if (!draftBootReady) { toast('正在恢复本期剪辑，请稍候'); return; }
  if (draftRecoveryBlocked) { toast('本期音频尚未完整恢复，原文件已保留；请先处理恢复提示再返回主页', 6500); return; }
  returningHome = true;
  const button = document.querySelector('#btn-home'), label = button.querySelector('span');
  button.disabled = true;
  engine.pause(); stopAudition();
  try {
    // Import/ASR still holds audio in this page. Finish that work before leaving.
    while (asrJobs.some(job => job.status === 'running' || job.status === 'queued')) {
      label.textContent = '等待转写…';
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    label.textContent = '保存中…';
    for (const job of alignmentJobs.values()) job.abort();
    for (const job of speakerJobs.values()) job.abort();
    window.clearTimeout(draftSaveTimer);
    await saveAndLeave({ save: () => flushDraftSave({ toastFail: true }), navigate: () => location.assign('/') });
  } catch (error) { toast(`尚未返回主页：${error instanceof Error ? error.message : String(error)}`, 6500); }
  finally { returningHome = false; button.disabled = false; label.textContent = '回到主页'; }
});
window.addEventListener("pagehide", flushDraftOnUnload);
window.addEventListener("beforeunload", ev => {
  if (draftWriter.dirty || draftWriter.saving) { flushDraftOnUnload(); ev.preventDefault(); ev.returnValue = ""; }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushDraftOnUnload();
});
syncChrome();




for (const side of ["before","after"]) document.querySelector(`#music-anchor-${side}`).addEventListener("click", () => {
  const m = project?.music.find(m=>m.id===activeMusicId);
  const clip = project?.clips.find(c=>c.id===m?.clipId);
  const word = clip?.words.find(w=>w.id===m?.wordId);
  if (!m || !word) return;
  m.anchorSide=side; m.originalTime=side==="before" ? word.start : word.end;
  syncEngineFromProject(); refreshMusicUi(); syncChrome(); scheduleDraftSave();
});

function moveMusicToAnchor(id,anchor) {
  const m=project?.music.find(m=>m.id===id),clip=project?.clips.find(c=>c.id===anchor.clipId);
  const word=clip?.words.find(w=>w.id===anchor.wordId&&!w.deleted);
  if(!m||!word)return;
  m.clipId=clip.id;m.wordId=word.id;m.anchorSide=anchor.atEnd?"after":"before";m.originalTime=anchor.atEnd?word.end:word.start;
  activeMusicId=m.id;dragMusicId=null;
  syncEngineFromProject();refreshMusicUi();syncChrome();scheduleDraftSave();
  toast(`已移动「${m.name}」到「${word.text}」${anchor.atEnd?"之后":"之前"}`);
}
el.transcript.addEventListener("dragstart",ev=>{
  const chip=ev.target.closest?.(".music-chip");if(!chip?.dataset.musicId)return;
  dragMusicId=chip.dataset.musicId;hideKindChooser();
  ev.dataTransfer?.setData("application/x-podcast-placement",dragMusicId);
  if(ev.dataTransfer)ev.dataTransfer.effectAllowed="move";
  chip.classList.add("dragging");window.getSelection()?.removeAllRanges();
});
el.transcript.addEventListener("dragend",()=>{dragMusicId=null;clearDropHover();el.transcript.classList.remove("sfx-dragging");for(const n of el.transcript.querySelectorAll(".music-chip.dragging"))n.classList.remove("dragging");});
el.transcript.addEventListener("keydown",ev=>{const chip=ev.target.closest?.(".music-chip");if(chip && (ev.key==="Enter"||ev.key===" ")){ev.preventDefault();selectMusic(chip.dataset.musicId);}});

el.transcript.addEventListener("pointerdown",ev=>{
  const chip=ev.target.closest?.(".music-chip");if(!chip?.dataset.musicId||ev.button!==0)return;
  ev.preventDefault();chip.setPointerCapture(ev.pointerId);
  musicPointerDrag={id:chip.dataset.musicId,chip,x:ev.clientX,y:ev.clientY,moved:false};
});
window.addEventListener("pointermove",ev=>{
  const drag=musicPointerDrag;if(!drag)return;
  if(!drag.moved && Math.hypot(ev.clientX-drag.x,ev.clientY-drag.y)<6)return;
  drag.moved=true;dragMusicId=drag.id;drag.chip.classList.add("dragging");
  window.getSelection()?.removeAllRanges();
  const anchor=resolveDropAnchor(ev.clientX,ev.clientY,document.elementFromPoint(ev.clientX,ev.clientY));
  setDropHover(anchor,project?.music.find(m=>m.id===drag.id)?.kind==="stinger");
  const canvas=document.querySelector(".canvas"),r=canvas.getBoundingClientRect();
  if(ev.clientY>r.bottom-45)canvas.scrollBy(0,16);else if(ev.clientY<r.top+45)canvas.scrollBy(0,-16);
});
window.addEventListener("pointerup",ev=>{
  const drag=musicPointerDrag;if(!drag)return;musicPointerDrag=null;
  drag.chip.classList.remove("dragging");suppressMusicClickUntil=Date.now()+350;
  if(drag.moved) {
    const anchor=resolveDropAnchor(ev.clientX,ev.clientY,document.elementFromPoint(ev.clientX,ev.clientY))??dropAnchor;
    if(anchor)moveMusicToAnchor(drag.id,anchor);
  } else selectMusic(drag.id);
  dragMusicId=null;clearDropHover();
});
window.addEventListener("pointercancel",()=>{musicPointerDrag?.chip.classList.remove("dragging");musicPointerDrag=null;dragMusicId=null;clearDropHover();});


mountRoughCut({
  productionDefaults:()=>({speechRate:project?.speechRate??1,hasMusic:!!project?.music?.length,hasHighlights:!!project?.clips.some(c=>c.id.startsWith('teaser-'))}),
  materials:()=>listSfxLibrary(),
  material:async(id)=>{const meta=(await listSfxLibrary()).find(m=>m.id===id),blob=await getSfxBlob(id);return meta&&blob?{blob,name:meta.name,duration:meta.duration}:null;},
  duration:async(blob)=>(await engine.decodeArrayBuffer(await blob.arrayBuffer())).duration,
  previewQuote:(clipId,startWordId,endWordId)=>{
    const clip=project?.clips.find(c=>c.id===clipId),first=clip?.words.find(w=>w.id===startWordId),last=clip?.words.find(w=>w.id===endWordId);
    if(!clip||!first||!last||last.end<=first.start)return;
    stopAudition();engine.pause();auditionContext??=new AudioContext();void auditionContext.resume();
    auditionSource=auditionContext.createBufferSource();auditionSource.buffer=clip.cleanBuffer||clip.buffer;auditionSource.connect(auditionContext.destination);auditionSource.start(0,first.start,last.end-first.start);
  },
  ready:()=>!!project?.clips.length && draftBootReady && !draftRecoveryBlocked,
  defaults:()=>({threshold:thresholdSec,breaths:true}),
  revision:()=>draftRevision(),
  clean:()=>!draftWriter.dirty&&!draftWriter.saving,
  prepare:async(options)=>{
    if(asrJobs.some(j=>j.status==='running'||j.status==='queued'))throw Error('请等转写完成后再初剪');
    if(!await persistDraftCritical()||draftStorageKind()!=='disk')throw Error('请先完成本机草稿保存');
    const pauses=[];
    for(const clip of project.clips){
      const order=ensureAudioOrder(clip);
      for(const group of groupPauseMarks(clip.words,[...clipPauses(clip,options.breaths),...(clip.clearedPauses??[]).map(p=>({...p,cleared:true}))],order)){
        const parts=bulkPauseParts(group,options.threshold).map(p=>({start:p.start,end:p.end}));
        const breath=options.breaths&&group.parts.some(p=>p.breath);
        if(pauseExceedsThreshold(parts,options.threshold))pauses.push({clipId:clip.id,parts,breath});
      }
    }
    return {revision:draftRevision(),pauses};
  },
  load:async()=>{if(!await tryRestoreDraft())throw Error('初剪已保存，但页面恢复失败，请重新打开页面');},
  preview:(seam)=>{
    const index=project?.clips.findIndex(c=>c.id===seam.clipId);if(index===undefined||index<0)return;
    engine.pause();engine.seekOriginal(index,seam.start);engine.seek(Math.max(0,engine.getEditTime()-1.5));engine.play(engine.getEditTime());
    activeClipId=seam.clipId;syncChrome();
  }
});

// A bed may establish the opening before the anchor word; persists with the placement.
document.querySelector('#music-lead').addEventListener('input',event=>{
 const m=project?.music.find(m=>m.id===activeMusicId);if(!m||m.kind!=='bed')return;
 const value=Number(event.target.value);if(!Number.isFinite(value))return;
 m.leadInSec=Math.max(0,Math.min(30,resolveMusicRegion(m).duration,value));
 syncEngineFromProject();renderTrack();refreshMusicUi();syncChrome();scheduleDraftSave();
});

mountPublicationExport(()=>project?.clips.length?episodeSegments(project.clips,project.music,project.speechRate??1):null,()=>project?.audioName??'podcast');

window.addEventListener("podcut:themechange",()=>paintWordRailWave());
