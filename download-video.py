"""Download one public video with yt-dlp. No browser login cookies are read."""
import json
import os
import sys
from pathlib import Path
import yt_dlp

url, folder, tools, node = sys.argv[1:5]
last = -1
def output(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def progress(status):
    global last
    if status['status'] == 'downloading':
        total = status.get('total_bytes') or status.get('total_bytes_estimate')
        percent = int(status.get('downloaded_bytes', 0) / total * 100) if total else 0
        if percent // 10 != last:
            last = percent // 10
            output({'progress': f'正在下载视频… {percent}%'})

class Logger:
    def debug(self, message): pass
    def warning(self, message): pass
    def error(self, message): pass

def permitted(info, *, incomplete=False):
    if info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming'):
        return '请分享已发布的单条视频，暂不处理直播。'
    if (info.get('duration') or 0) > 3600:
        return '单条视频暂限 60 分钟以内。'
    if (info.get('filesize') or 0) > 500 * 1024 * 1024:
        return '视频超过 500MB，请导入较小的文件。'

options = {
    'noplaylist': True, 'playlist_items': '1',
    'outtmpl': str(Path(folder) / 'video.%(ext)s'),
    'format': 'bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*[height<=720]+ba/b',
    'merge_output_format': 'mp4', 'ffmpeg_location': tools,
    'js_runtimes': {'node': {'path': node}},
    'socket_timeout': 25, 'retries': 2, 'extractor_retries': 1,
    'fragment_retries': 2, 'max_filesize': 500 * 1024 * 1024,
    'match_filter': permitted, 'progress_hooks': [progress],
    'logger': Logger(), 'quiet': True, 'no_warnings': True,
    'writeinfojson': False, 'writethumbnail': False,
}
try:
    output({'progress': '正在通过多平台下载组件解析视频…'})
    with yt_dlp.YoutubeDL(options) as downloader:
        info = downloader.extract_info(url, download=True)
    if not info:
        raise RuntimeError('没有获取到单条视频。')
    if info.get('entries'):
        info = next((entry for entry in info['entries'] if entry), None)
    files = [p for p in Path(folder).glob('video.*')
             if p.suffix.lower() in ('.mp4', '.mkv', '.webm', '.mov', '.flv')]
    if not files:
        raise RuntimeError('没有收到可播放视频。')
    file = max(files, key=lambda p: p.stat().st_size)
    output({'done': True, 'file': str(file), 'id': str(info.get('id') or ''),
            'title': str(info.get('title') or '视频')[:100],
            'description': str(info.get('description') or '')[:10000],
            'author': str(info.get('uploader') or ''),
            'sourceUrl': str(info.get('webpage_url') or url)})
except Exception as error:
    # Errors stay local; omit query strings which can contain share tokens.
    import re
    message = re.sub(r'https?://\S+', '[平台链接]', str(error))[:500]
    output({'error': message})
    sys.exit(1)
