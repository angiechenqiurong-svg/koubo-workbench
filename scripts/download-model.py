"""Download only the pinned official model files; resume by rerunning setup."""
import os
import hashlib
from pathlib import Path
import urllib.request
import argparse
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--model', choices=['base', 'small'], default='base')
choice = parser.parse_args().model
MODEL = ROOT / ('.speech-model-small' if choice == 'small' else '.speech-model')
REVISION = ('536b0662742c02347bc0e980a01041f333bce120' if choice == 'small'
            else 'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66')
BASE = f'https://huggingface.co/Systran/faster-whisper-{choice}/resolve/{REVISION}/'
MODEL.mkdir(exist_ok=True)
MODEL_SHA256 = ('3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671'
                if choice == 'small' else
                'd01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9')
def valid_model(file):
    digest = hashlib.sha256()
    with file.open('rb') as data:
        while chunk := data.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest() == MODEL_SHA256
for name in ('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'):
    destination = MODEL / name
    # A successful download is renamed atomically; partial downloads never count.
    if destination.exists() and destination.stat().st_size > 0 and (name != 'model.bin' or valid_model(destination)):
        print(f'{name} 已存在', flush=True)
        continue
    temporary = MODEL / (name + '.part')
    print(f'正在获取 {name}…', flush=True)
    request = urllib.request.Request(BASE + name, headers={'User-Agent': 'koubo-workbench/0.3'})
    try:
        if shutil.which('curl'):
            # macOS system curl uses the installed trust store. Keep certificate
            # verification enabled, including after Hugging Face redirects.
            subprocess.run(['curl', '--http1.1', '--fail', '--silent', '--show-error', '--location',
                            '--retry', '3', '--retry-all-errors', '--continue-at', '-',
                            '--connect-timeout', '20', '--max-time', '1200',
                            '--output', str(temporary), BASE + name], check=True)
            expected, total = 0, temporary.stat().st_size
        else:
            with urllib.request.urlopen(request, timeout=120) as source, temporary.open('wb') as output:
                expected = int(source.headers.get('Content-Length', 0))
                total = 0
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    total += len(chunk)
        if total == 0 or expected and total != expected:
            raise RuntimeError(f'{name} 下载不完整，请重新运行安装入口。')
        if name == 'model.bin' and not valid_model(temporary):
            temporary.unlink(missing_ok=True)
            raise RuntimeError('模型校验失败，请重新运行安装入口。')
        os.replace(temporary, destination)
    except Exception:
        # Keep partial downloads for curl's next range request. They are never
        # renamed to the live model, so an interrupted download stays inactive.
        if not shutil.which('curl'):
            temporary.unlink(missing_ok=True)
        raise
print('官方模型文件已准备完成。', flush=True)
