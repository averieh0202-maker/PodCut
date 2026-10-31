# 安装与使用

当前发行目标是**本机单用户源码版**。打开浏览器界面后，服务仍在自己的电脑上运行。不要把开发服务直接暴露到公网。

## 1. 准备环境

- Node.js 22 或更新版本及 npm。
- 桌面浏览器；优先使用近期 Chromium 浏览器。
- 完整音频导出和可选降噪需要 FFmpeg、ffprobe。两者应来自同一安装，位于 `/opt/homebrew/bin`、`/usr/local/bin` 或 `/usr/bin`。当前后端只检查这些位置，不支持任意 PATH。
- macOS 已验证构建和本机功能；Linux 尚未完成整条链路验证。原生 Windows 的 FFmpeg 查找和 Python 虚拟环境路径尚未适配，不能保证完整功能。

macOS 已安装 Homebrew 时，可用 `brew install node ffmpeg`。没有 Homebrew 时，先按 [Node.js 官方下载页](https://nodejs.org/en/download) 和 [FFmpeg 下载页](https://ffmpeg.org/download.html) 安装对应工具。不要将原使用环境的依赖、密钥或草稿复制进源码目录。

## 2. 启动

下载并解压源码包，在终端进入解压得到的 `PodCut-Open-Source` 目录，然后执行：

```sh
npm ci
npm run doctor
npm start
```

首次启动会构建页面，随后同时提供前端和本机 API。保持终端运行，浏览器打开 `http://127.0.0.1:5188/`。停止时按 Ctrl+C，再次使用运行 `npm start`。

macOS 若希望关闭终端后仍能使用，并在登录后自动启动，执行一次：

```sh
npm run service:install
```

系统会托管当前副本，异常退出后自动重启。配置位于当前用户的 `Library/LaunchAgents`，日志和构建检查记录位于本副本 `.podcast-drafts/service/`。

- 查看状态：`npm run service:status`
- 启动已安装的服务：`npm run service:start`
- 重启并读取最新配置：`npm run service:restart`
- 停止到下次登录：`npm run service:stop`
- 移除登录启动：`npm run service:uninstall`

自动登录启动安装器目前支持 macOS；其他系统可用 `npm start`，再配置相应系统的服务管理器。开发源码时使用 `npm run dev:opensource`；日常生产模式不因源码文件变动自动刷新编辑页。

5188 被占用时不会自动切换端口。先检查是否已经开着同一副本；不要为此关闭另一套正在使用的 PodCut。始终使用相同的主机名与端口，避免浏览器把它当成另一份存储。

## 3. 接入自己的 API

```sh
cp .env.example .env.local
```

用文本编辑器填写 `VOLC_APP_KEY`，并确认语音识别服务已经开通、资源 ID 和调用模式相符。保留模板中的默认资源 ID 和 `submit` 模式，仅在服务商要求时修改。转写会把录音交给火山引擎，费用由相应账户承担。

Agent 初剪可以在页面填写 API Base URL、模型名称和 Key；后端使用兼容 Chat Completions 的接口，不保证所有标称兼容的服务均可用。Base URL 不需要重复填写 `/chat/completions`。连接测试也会发送一个小请求，可能计费。

也可以在 `.env.local` 配置 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` 和 `DEEPSEEK_BASE_URL` 作为默认服务。模型名称以账户实际可用模型为准。修改环境配置后重启本副本。密钥不使用 `VITE_` 前缀，也不要加入版本管理。

## 4. 完成第一份剪辑

1. 在主页新建剪辑；第一次使用的历史列表应为空。
2. 「片段 → 导入音频」添加录音。文件格式是否可解码也取决于浏览器，优先用 WAV / MP3。
3. 等待转写，检查文字和说话人标识。自动分离可能将声音相似的人合并，不能保证识别人数准确。
4. 打开「Agent 初剪」，选择自己的 API，按需上传 DOCX / TXT 参考稿、设置精句和配乐等选项，再执行。参考稿用于辅助理解，不表示所有稿外内容都应删除。
5. 人工试听、删除或复原文字，检查英文、吸气、重录及剪切接缝。自动剪辑可能误删或漏删。
6. 从「素材」导入自己的配乐，或加载程序生成的演示配乐。调整人声倍速时，插入音乐保持原速。
7. 回到主页后重新打开剪辑，确认修改已保存。
8. 从右上角「导出」选择音频、文字稿、播客长文稿或简介与时间戳。长文稿导出保留剪后原话，不承担事实核查或个人文风改写；简介生成可能调用所配置的 AI。

公开源码包不附带在线 TTS 生成的演示朗读。点击「加载演示」缺少音频时会给出提示，不会清空当前剪辑。若本机已有演示文件，仍可照常使用；这些文件不应随公开包分发。

## 5. 可选的本机字界校准

基础安装不会下载模型。需要本机强制对齐时，先检查模型条款和磁盘空间，安装 Python 3.12，然后执行：

```sh
npm run setup:alignment
```

脚本在本项目建立 `.alignment-venv/` 和 `.alignment-model/`，安装锁定的 Python 依赖并从 ModelScope 下载 Qwen ForcedAligner 与时间戳模型。下载可能较慢且需要额外空间。推理使用本机 CPU 或 Apple MPS；不把音频发给模型服务。模型文件和其许可声明会尽可能一并保存。

本轮没有在全新机器安装这套大型依赖或重新验证推理。旧环境的依赖锁定清单不能视为所有系统都能安装的保证。缺少模型时，不应把声学校准效果当作已经启用；可以使用已有 ASR 时间戳并人工精修。

## 排错

| 现象 | 处理 |
| --- | --- |
| `npm` 找不到 | 安装 Node.js 后重新打开终端 |
| `npm ci` 网络失败 | 检查 npm registry 网络连接，保留 lockfile 后重试 |
| 页面打不开／连接被拒绝 | macOS 已安装后台服务时运行 `npm run service:status` 和 `npm run service:start`；未安装时运行 `npm start` 并保持终端开启 |
| 页面资源加载失败 | 使用页面的「重新加载」，并检查服务状态；启动会校验构建文件，缺失或截断时自动重建 |
| 端口占用 | 检查是否已启动本副本，不要结束不相关的服务 |
| 导出提示 FFmpeg 不存在 | 运行 `npm run doctor`，检查上述受支持路径及 ffprobe |
| API 返回 401 / 403 | 检查 Key、服务权限、地址和资源 ID |
| API 返回额度错误 | 查看服务账户额度；开源软件不包含免费 API 调用 |
| 历史项目看不到 | 确认启动目录和浏览器地址一致，不要删除草稿目录尝试修复 |

`npm run build` 仅生成前端构建产物，不会将后端变成可用的多人云服务。只把 `dist/` 上传静态托管无法完整运行本项目。
