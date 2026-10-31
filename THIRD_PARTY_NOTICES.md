# 第三方声明

核对日期：2026-10-27。PodCut 自有代码使用 AGPL-3.0-only；下面组件仍遵守各自许可。本次准备交付源码，不附带 node_modules、Python 虚拟环境、模型权重、FFmpeg 二进制或 dist 构建产物。

## JavaScript 依赖

完整锁定清单见 [npm-inventory.json](public/licenses/npm-inventory.json)，本机已安装依赖的原始许可/NOTICE 文本保存在 [public/licenses/npm](public/licenses/npm)。许可收集命令为 `npm run licenses:collect`，不会联网。

| 组件 | 核对版本 | 包声明 |
| --- | --- | --- |
| @soundtouchjs/core、audio-worklet、interpolation-strategy-lanczos、worklet-base | 均 2.1.1 | MPL-2.0 |
| Vite | 6.4.4 | MIT；其 LICENSE 同时包含被打包依赖的声明 |
| TypeScript | 5.7.3 | Apache-2.0；附带 ThirdPartyNoticeText |
| esbuild、Rollup | 0.25.12、4.64.7 | MIT |
| picocolors | 1.1.1 | ISC |
| source-map-js | 1.2.2 | BSD-3-Clause |
| 其他本机已安装依赖 | 见清单 | MIT |

共记录 69 个锁定包，本机安装了其中 19 个；其余为平台相关可选包，未逐个下载核对，不将未知字段当作许可已确认。17 个包自带许可文本；本机 esbuild / Rollup 的平台二进制包标为 MIT，声明另见对应主包。本源码包不分发这些二进制。

SoundTouchJS 原始源码仓库：[cutterbl/SoundTouchJS](https://github.com/cutterbl/SoundTouchJS)。安装包未修改，版本与校验值记录在 lockfile 和清单中。这里没有把它的 MPL 源码改为仅 AGPL。

[Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) 说明了发布可执行/压缩 JavaScript 时提供对应源码及保留声明的要求。正式发布浏览器构建产物时，需要固定并验证与 2.1.1 包对应的上游源码版本，将源码获取入口与声明一起提供；仅附上编译后的 npm 文件不等于已提供其 TypeScript 源码。源码仓库发布与公开在线服务是两个不同交付阶段。

## 字体与音频

IBM Plex Sans 字体采用 SIL Open Font License 1.1，保留完整的 [原始版权与许可](public/fonts/IBM-Plex-Sans-OFL.txt)，包括 Reserved Font Name。字体未修改。

`public/sfx` 的三段配乐由本项目 `scripts/gen-tech-sfx.py` 使用数学波形生成，没有采样外部歌曲；这些项目自有演示资源按本项目 AGPL-3.0-only 提供。其生成脚本可重建音频。

`docs/promo/tech/podcut-tech-film.mp4` 中的电子配乐与操作音效为数学波形原创合成，没有采样外部歌曲，按本项目 AGPL-3.0-only 提供。画面素材来源和演示边界见 [宣传素材说明](docs/promo/README.md)。

`public/demo/sample.wav` 和 `sample16k.mp3` 由 `edge-tts` 调用在线服务生成。该工具开源不代表服务输出的再分发权已确认；本次未能确认输出授权，两个文件已被 Git 排除并从源码包移除。本机已有文件不删除。参考：[edge-tts 项目](https://github.com/rany2/edge-tts)。不随包分发 edge-tts，也不自动调用它。`scripts/gen_demo.py` 仅保留为可选生成示例，运行前应自行确认服务条款。

## 外部音频工具与可选模型

- FFmpeg / ffprobe 由使用者自行安装，本项目通过独立进程调用。FFmpeg 的许可取决于构建选项，可能为 LGPL 或 GPL；不能把不同构建统一标成 LGPL。参见 [FFmpeg 官方法律说明](https://ffmpeg.org/legal.html)。本源码包不含 FFmpeg。
- Qwen3-ForcedAligner-0.6B 官方模型卡标为 Apache-2.0，参见 [Qwen 官方模型卡](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B)。模型不随包分发。
- `iic/speech_timestamp_prediction-v1-16k-offline` 的具体模型授权仍须按 [ModelScope 模型页](https://www.modelscope.cn/models/iic/speech_timestamp_prediction-v1-16k-offline) 确认；不能用 FunASR 框架的 MIT 许可替代模型许可。当前不打包该模型。
- 可选 Python 依赖由安装脚本下载，已整理 [锁定依赖元数据核对表](docs/python-dependencies.json)。这是已有环境的包元数据记录，不是对所有传递依赖、二进制内容或所有平台的授权保证。qwen-asr / ModelScope / Transformers 包声明为 Apache-2.0，FunASR 包声明为 MIT；其他声明以清单和各包原文为准。

后续如果提供容器、安装器、模型镜像或预编译下载，应按实际包含的文件重新核对，不直接沿用本源码包的范围。

`docs/promo/versions` 保存历次宣传成片。V04 的配乐和音效同样为项目原创数学波形合成，未采样外部歌曲；项目自有资源按 AGPL-3.0-only 提供。苹果官方产品页仅用于研究展示方式，不包含苹果图片、视频、配乐或商标素材。

V05 使用本机系统字体渲染宣传画面，不分发字体文件；配乐沿用项目原创合成配乐。高清界面特写为根据实录重绘，见 [V05 制作说明](docs/promo/versions/v05-refined-type/README.md)。

V06 的配乐和音效为项目原创合成，文字以本机苹方字体渲染，不分发字体文件；深色功能画面为基于实录内容的后期动效重绘，详见 [V06 说明](docs/promo/versions/v06-continuous-motion/README.md)。
