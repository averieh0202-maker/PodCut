import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Inspect only Git publication candidates. Never print matching secret values.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
const allowedAudio = new Set(['public/sfx/opening-tech.wav', 'public/sfx/transition-tech.wav', 'public/sfx/ending-tech.wav']);
const findings = [];
for (const file of files) {
  const flag = reason => findings.push({ file, reason });
  const stat = lstatSync(path.join(root, file));
  if (stat.isSymbolicLink() || !stat.isFile()) { flag('non-regular file'); continue; }
  if (stat.nlink > 1) flag('shared hard link');
  if (/(^|\/)(?:\.env(?:\..+)?|\.podcast-drafts|\.alignment-model|\.alignment-venv|outputs|recordings|uploads|backups)(\/|$)/.test(file) && file !== '.env.example') flag('private configuration or runtime path');
  if (/\.(?:f32|wav|mp3|m4a|aac|flac|ogg|aiff|docx|pdf|zip)$/i.test(file) && !allowedAudio.has(file)) flag('unreviewed media or document');
  if (!/\.(?:[cm]?[jt]sx?|json|md|txt|css|html|py|sh)$/.test(file) && file !== '.env.example') continue;
  const text = readFileSync(path.join(root, file), 'utf8');
  if (/\/(?:Users|home)\/[A-Za-z0-9_.-]+\//.test(text)) flag('personal absolute path');
  if (/\bsk-[A-Za-z0-9_-]{24,}\b/.test(text) || /\bAKIA[A-Z0-9]{16}\b/.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) flag('credential-shaped content');
  if (file === '.env.example') {
    for (const line of text.split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && /KEY|TOKEN|SECRET|PASSWORD/.test(match[1]) && match[2].trim()) flag('nonempty example credential');
    }
  }
}
console.log(JSON.stringify({ candidateFiles: files.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
