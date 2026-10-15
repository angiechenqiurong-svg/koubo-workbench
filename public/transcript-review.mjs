const normalize = text => String(text || '').replace(/[\s\p{P}]/gu, '').toLowerCase();
export function transcriptReference(record, segment) {
  const fromCaptions = record.transcriptSource?.startsWith('ocr');
  const source = fromCaptions ? record.audioSegments : record.subtitleSegments;
  const nearby = (source || []).filter(s => s.end > segment.start && s.start < segment.end);
  const text = nearby.map(s => s.text).join(' ');
  const current = normalize(segment.text), reference = normalize(text);
  return {text, label: fromCaptions ? '语音识别初稿' : '画面字幕初稿',
    differs: !!reference && current.length >= 4 && !reference.includes(current) && !current.includes(reference)};
}
