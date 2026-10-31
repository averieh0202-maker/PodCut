# 运行与工程格式

以下命令在 PodCut 项目根目录运行。通过结构化文件写入清单；路径无需 shell 插值。依赖现有 Node、Vite/esbuild、FFmpeg、本机对齐模型、转写服务和 DeepSeek 配置。

## 输入清单

```json
{
  "name": "本期播客",
  "audio": ["/绝对路径/第一段.wav", "/绝对路径/第二段.wav"],
  "reference": "/绝对路径/参考稿.docx",
  "music": {
    "opening": "/绝对路径/开头.mp3",
    "transitions": ["/绝对路径/过场1.mp3", "/绝对路径/过场2.mp3"],
    "ending": "/绝对路径/结尾.mp3"
  },
  "pauseThreshold": 0.3,
  "leadInSec": 3,
  "voiceGainDb": 0,
  "previewUrl": "http://127.0.0.1:5188"
}
```

`pauseThreshold` 是整处停顿（含检出的吸气）的总时长阈值，0.3 秒只是缺省值，应沿用用户选择；低于 0.1 秒不单独标记。声学护音余量不另生成停顿。人声增益独立于素材，按录音实际响度决定，不能盲目大幅放大。

可选 `aligned` 条目 `{ "sha256": "源录音SHA256", "path": "/字界缓存.json", "complete": true }`。仅用于已经验证与该原始录音匹配、完成过声学校准的缓存。文件结构 `{words:[...]}`；`complete` 不会伪造每个字的对齐来源，没有可靠字界的字仍受保护。没有证明就不填。

## 执行

```sh
node agent-tools/episode.mjs prepare /绝对路径/episode.json /绝对路径/本期工作目录
```

转写可能需要联网；本机对齐服务必须正在运行。使用 `.env.local` 已有凭据。prepare 会缓存转写、逐块对齐、语义剪辑计划，生成：

- `prepared.json`：原稿、可复原初剪结果、章节和候选。
- `choices.json` 与 `q1.wav` 等：供用户选择的原话和试听。
- `status.json`：阶段；`awaiting-highlight-choice` 表示等待用户。

不要让终端长时间阻塞沟通；长任务保存日志并定期读取明确进度。错误需修复后运行相同命令恢复。

用户选定多个精句后（以逗号分隔，排列顺序就是片头顺序）：

```sh
node agent-tools/episode.mjs assemble /绝对路径/本期工作目录 episode-20261017 q1,q3,q5 --confirmed
```

项目编号只能使用小写字母、数字、连字符，最长 80 字符。已存在的编号会拒绝覆盖；继续人工精修必须打开原项目，不重新 assemble。

输出 `.podcast` 是工程**文件夹**，不是通用 ZIP 或单个 JSON。内部是 PodCut DiskDraftStore 快照和按 SHA256 寻址的完整素材。`current.json` 引用 `assets/<sha256>`；`snapshots/` 保留可恢复记录。复制时必须复制整个文件夹。组装同时安装到：

`<PodCut项目根目录>/.podcast-drafts/projects/<project-id>`

结果 URL `http://127.0.0.1:5188/?project=<project-id>` 会直接打开该独立工程。默认无 project 参数的原稿不受影响。浏览器以 `X-Project-Id` 选择本机草稿，保存仍使用版本比较避免覆盖旧版本。

恢复外部工程：

```sh
node agent-tools/episode.mjs import /绝对路径/工程.podcast new-project-id
```

## 配乐与导出

配乐依旧是独立的 `MusicPlacement`。`kind: bed` 为背景；`kind: stinger` 为插入式过场。`leadInSec` 表示背景先播多少秒，随后从锚定字开始人声。起始样本不会因此被裁掉。`wordId + anchorSide` 在调整字界后仍跟随该字；片尾用最后发声字的 `after`。

网页中点蓝色背景音乐块，在素材面板调整“音乐先行”。文字上的背景标识显示覆盖区域，素材块显示先行秒数。人声效果与配乐音量独立。

用户精修结束后，直接导出播客长文稿（不调用 AI）：

```sh
node agent-tools/episode.mjs transcript episode-20261017 /绝对路径/发布资料
```

生成 `长文稿.md`、`导出说明.md` 与 `发布资料来源.json`。直接整理当前剪后原话为段落，不调用 AI 改写，不加载个人文风，也不生成文章核查报告。网页“导出播客长文稿”同样可直接下载，不需要 AI API。后续改写交给用户自己的 Agent，详见 [文字稿导出规则](publication.md)。

若另需 AI 生成简介和时间戳，使用网页对应按钮，或运行：

```sh
node agent-tools/episode.mjs publish episode-20261017 /绝对路径/发布资料
```

此命令先保存原话长文稿，再调用模型生成 `简介与时间戳.md`；API 失败不影响已经写出的长文稿。时间由实际剪后音频排程计算。音频继续使用网页“导出剪辑音频”。继续剪辑后须重新导出，防止文字和时间戳过期。

## 检查与局限

改动配乐或工程格式后运行 `node scripts/test-episode.mjs`、`npm run test:regressions`、`npm run test:draft`、`npm run build`。测试只证明排程与数据不变量，还须实际打开并试听真实录音。

当前吸气检测是声学启发式而非专门训练的呼吸分类器。不能声称百分百去除所有吸气。转写与声学校准失败时不伪造时间、不跳过阶段交付“完成”；保留日志、缓存与原始音频供续跑。

每条候选的 parts 只含一个真实连续原话范围。用户从多个候选中选择后才串烧，可跨不同录音片段。`editorialPlan` 可指向经 Codex 核对的方案 JSON `{title, highlights:[{title,reason,parts:[{startId,endId}]}], chapters:[{id,title}]}`；ID 必须取 `prepared-audio.json` 的 `segments[].id`。不要填原词末尾 ID，也不要改写录音。自动方案校验失败时，可据真实剪后段落修订该文件后重新 prepare；不得跳过校验。


## 网页 Agent 初剪（2026-10-19.2）

在已导入、转写并校准的工程中打开“Agent 初剪”。API 区填写兼容 Chat Completions 的 Base URL、模型和 Key，测试后保存；服务配置在 `.podcast-drafts/agent-ai.json`（仅本机用户可读写）。不在版本库或工程中保存密钥，不把 Key 放进模型提示词。切换 API 服务时需填写新 Key，不自动将旧 Key 转发到新站点。现有 DeepSeek 环境配置作为未绑定时的后备。

片头可选不添加、用户选候选、或明确授权自动选。配乐可保留现有或按所选素材重新安排；开头/过场/片尾均允许不添加，支持素材库及上传。音乐保持原速，人声倍率影响试听与导出。用户选候选时停在 awaiting_selection，确认或明确跳过后才组装；期间不覆盖当前工程。

初剪、组装及自动打开有版本检查；当前工程发生新修改就拒绝覆盖。规则源在仓库 `skills/podcast-producer`，更新后同步用户级 skill；任务记录实际规范版本及哈希。用 `node scripts/test-agent-production.mjs` 验证完整制作状态与保护。
