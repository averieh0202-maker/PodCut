# PodCut independent source repository

This repository is an independent installation. Make changes only here; do not synchronize changes or runtime data back to another PodCut installation.

- Never commit API keys, `.env.local`, recordings, user transcripts, project snapshots, private acoustic fixtures, model weights, exports, or personal writing profiles.
- Runtime data belongs to this repository's own `.podcast-drafts/`. Never point it at another installation or link to another installation's files.
- Use port 5188 with strict port selection for this copy. Do not stop another local server to reclaim its port.
- Preserve existing editing behavior. Publishing a repository or calling paid AI services requires the user's authorization. Never include private runtime data in a publication.
- Keep third-party license and copyright notices. The author selected AGPL-3.0-only for project-owned code; preserve the LICENSE file and third-party license boundaries.
- Run `npm run check:release`, `npm run build`, and relevant local tests after source changes. No real user audio is required for the smoke tests.

## 宣传视频版本保留

- 用户要求保留每次交付的剪辑结果。新一轮反馈必须创建新的版本目录，不能覆盖、删除或改写已交付版本的成片、配乐、封面和制作配置。
- 成片存入 `docs/promo/versions/vNN-description/`，维护版本目录页和 SHA-256 文件清单；保留独立预览页。制作源文件及含本机路径的素材映射放入独立审计目录，不能带入开源包。
- 尚未交付版本可以在制作和检查阶段修正；交付后冻结，下一轮修改另开新版本。

## Stable local service

- `npm start` serves a validated build and the local APIs on this copy's fixed port 5188. Development mode is for source work, not the daily background service.
- macOS users may register this copy with `npm run service:install`. Inspect `npm run service:status` before starting another listener. Never evict a different application or installation from its port.
- After validated source changes, a registered background service needs `npm run service:restart` to load the new build. Keep this copy separate from the user's other service and runtime data.
- Run `npm run test:service` and `npm run test:service:integration` after startup/recovery changes. Integration fixtures are generated in a temporary directory and contain no real recordings.
