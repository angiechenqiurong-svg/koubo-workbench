"""Build a source release from an allowlist, excluding local user data."""
import json
from pathlib import Path
import zipfile
ROOT = Path(__file__).resolve().parent.parent
version = json.loads((ROOT / 'package.json').read_text())['version']
files = ['README.md', 'LICENSE', 'THIRD_PARTY.md', 'CHANGELOG.md', '.gitignore',
         'package.json', 'package-lock.json', 'requirements-speech.txt',
         'server.mjs', 'browser.mjs', 'douyin.mjs', 'runtime.mjs', 'speech.py',
         'subtitles.mjs', 'subtitles.swift', '首次安装.command', '启动口播工作台.command']
for folder in ['public', 'scripts', 'test', '.github']:
    files.extend(str(f.relative_to(ROOT)) for f in (ROOT / folder).rglob('*')
                 if f.is_file() and '__pycache__' not in f.parts and f.suffix != '.pyc')
output = ROOT / 'dist' / f'koubo-workbench-{version}-macOS-source.zip'
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(set(files)):
        archive.write(ROOT / name, f'koubo-workbench/{name}')
print(f'发行包：{output}')
