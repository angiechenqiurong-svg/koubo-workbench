"""Offline Chinese transcription. Model files are installed separately."""
import json
import os
import sys
from faster_whisper import WhisperModel
from opencc import OpenCC

model_path = os.path.join(os.path.dirname(__file__), '.speech-model')
model = WhisperModel(model_path, device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
convert = OpenCC('t2s')
segments, info = model.transcribe(sys.argv[1], language='zh', beam_size=5, vad_filter=False, condition_on_previous_text=False, initial_prompt='以下是简体中文口播。')
for part in segments:
    text = convert.convert(part.text.strip())
    if text:
        print(json.dumps({'start': part.start, 'end': part.end, 'text': text}, ensure_ascii=False), flush=True)
print(json.dumps({'done': True}), flush=True)
