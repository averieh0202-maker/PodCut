import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const dest = path.join(root, 'public/licenses/npm');
mkdirSync(dest, { recursive: true });
const inventory = [];
for (const [dir, entry] of Object.entries(lock.packages)) {
  if (!dir) continue;
  const manifest = path.join(root, dir, 'package.json');
  const installed = existsSync(manifest);
  const pkg = installed ? JSON.parse(readFileSync(manifest, 'utf8')) : {};
  if (installed && pkg.version !== entry.version) throw Error(`Version differs from lockfile: ${dir}`);
  const name = pkg.name ?? dir.replace(/^node_modules\//, '');
  const notices = [];
  if (installed) {
    for (const filename of readdirSync(path.join(root, dir)).filter(n => /^(license|licence|notice|copyright|thirdpartynotice(?:s|text)?)(\.|$)/i.test(n))) {
      const out = `${name.replace(/[@/]/g, '_')}-${entry.version}-${filename}.txt`;
      copyFileSync(path.join(root, dir, filename), path.join(dest, out));
      notices.push(`npm/${out}`);
    }
  }
  inventory.push({ name, version: entry.version, license: pkg.license ?? entry.license ?? null,
    reviewedInstalledMetadata: installed, optional: !!entry.optional,
    registryArchive: entry.resolved, integrity: entry.integrity,
    repository: pkg.repository ?? null, notices });
}
writeFileSync(path.join(root, 'public/licenses/npm-inventory.json'), JSON.stringify({
  scope: 'Exact lockfile packages. Uninstalled platform-specific optional packages have not been inspected; null license is unknown, not unlicensed.', packages: inventory,
}, null, 2) + '\n');
console.log(`Recorded ${inventory.length} locked packages; copied notices for ${inventory.filter(p => p.notices.length).length} installed packages.`);
