"""Offline Chinese transcription. Model files are installed separately."""
import json
import os
import sys
from faster_whisper import WhisperModel
from opencc import OpenCC

root = os.path.dirname(__file__)
accurate_model = os.path.join(root, '.speech-model-small')
required = ('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt')
model_path = os.environ.get('KOUBO_SPEECH_MODEL') or (
    accurate_model if all(os.path.isfile(os.path.join(accurate_model, f)) for f in required)
    else os.path.join(root, '.speech-model'))
model = WhisperModel(model_path, device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
convert = OpenCC('t2s')
words = os.environ.get('KOUBO_SPEECH_VOCABULARY', '')[:500]
language = os.environ.get('KOUBO_SPEECH_LANGUAGE', 'auto')
language = None if language == 'auto' else language
# Some older macOS versions cannot load current ONNX Runtime. VAD is optional;
# keep local speech recognition available on those machines.
try:
    import onnxruntime
    use_vad = True
except (ImportError, OSError):
    use_vad = False
segments, info = model.transcribe(
    sys.argv[1], language=language, beam_size=5, vad_filter=use_vad,
    vad_parameters={'min_silence_duration_ms': 700, 'speech_pad_ms': 300},
    condition_on_previous_text=False, word_timestamps=True,
    initial_prompt=('Vocabulary: ' + words) if words else None,
    hotwords=words or None)
def emit(start, end, raw, uncertain=False):
    text = convert.convert(raw.strip())
    if text:
        print(json.dumps({'start': start, 'end': end, 'text': text, 'uncertain': uncertain}, ensure_ascii=False), flush=True)

for part in segments:
    uncertain = part.avg_logprob < -1.0
    if not part.words:
        emit(part.start, part.end, part.text, uncertain)
        continue
    sentence, start, end = '', None, part.start
    for word in part.words:
        if start is None:
            start = word.start
        sentence += word.word
        end = word.end
        if (any(mark in word.word for mark in '，,。！？!?；;') and len(sentence.strip()) >= 4) or len(sentence) >= 36:
            emit(start, end, sentence, uncertain)
            sentence, start = '', None
    if sentence.strip():
        emit(start, end, sentence, uncertain)
print(json.dumps({'done': True, 'language': info.language}), flush=True)
