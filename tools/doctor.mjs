import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
let failed = false;
function report(level, text) { console.log(`[${level}] ${text}`); if (level === 'FAIL') failed = true; }
report(Number(process.versions.node.split('.')[0]) >= 22 ? 'OK' : 'FAIL', `Node.js ${process.versions.node}（建议 22+）`);
report(existsSync(path.join(root, 'node_modules/typescript')) && existsSync(path.join(root, 'node_modules/vite')) ? 'OK' : 'FAIL', '构建依赖；缺少时先运行 npm ci');
// Match the current server's lookup, rather than claiming arbitrary PATH support.
const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(existsSync);
if (ffmpeg) {
  for (const program of [ffmpeg, ffmpeg.replace(/ffmpeg$/, 'ffprobe')]) {
    const r = spawnSync(program, ['-version'], { encoding: 'utf8', timeout: 5000 });
    report(r.status === 0 ? 'OK' : 'WARN', `${path.basename(program)} ${r.status === 0 ? '可运行' : '不可运行，音频导出可能失败'}`);
  }
} else report('WARN', '未在服务支持的位置发现 FFmpeg；完整音频导出与降噪不可用');
report(process.platform === 'win32' ? 'WARN' : 'OK', `当前平台 ${process.platform}；原生 Windows 音频后端尚未适配`);
const modelFiles = ['.alignment-venv/bin/python', '.alignment-model/model.safetensors', '.alignment-model/fa-zh/model.pt'];
report(modelFiles.every(f => existsSync(path.join(root, f))) ? 'OK' : 'WARN', '可选本机字界模型：仅检查文件存在，不代表推理已验证；缺少时仍可使用其他功能');
report('INFO', '不会读取或打印 API Key，也不会调用外部 AI 服务。绑定与额度需在网页配置。');
report('INFO', '默认地址 http://127.0.0.1:5188；当前版本用于本机单用户，不能直接作为公网多人服务。');
process.exitCode = failed ? 1 : 0;
