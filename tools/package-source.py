#!/usr/bin/env python3
"""Create a source-only ZIP from reviewed Git candidates, never the whole folder."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
git_root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=root, text=True).strip())
if git_root.resolve() != root:
    raise SystemExit('Run packaging in this repository, not an enclosing Git checkout.')
subprocess.run(['node', 'tools/check-release.mjs'], cwd=root, check=True)
files = sorted(set(filter(None, subprocess.check_output(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root
).decode().split('\0'))))
out = root / 'releases'
out.mkdir(exist_ok=True)
manifest = []
with zipfile.ZipFile(out / 'PodCut-source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        file = root / name
        if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(root):
            raise SystemExit(f'Invalid release file: {name}')
        data = file.read_bytes()
        archive.writestr('PodCut-Open-Source/' + name, data)
        manifest.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
(out / 'source-manifest.json').write_text(json.dumps({
    'license': 'AGPL-3.0-only', 'files': manifest,
}, ensure_ascii=False, indent=2) + '\n')
print(f'Packaged {len(files)} files into releases/PodCut-source.zip')
