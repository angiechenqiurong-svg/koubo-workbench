export const normalizedText=text=>String(text||'').replace(/[\s\p{P}]/gu,'').toLowerCase();
export function cleanTranscription(input,duration){
  const segments=[],warnings=[];let removed=0;
  for(const original of input){
    const text=String(original.text||'').trim(),start=Math.max(0,Number(original.start)),end=Math.min(duration,Number(original.end));
    if(!text)continue;
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start){removed++;continue;}
    const previous=segments.at(-1);
    if(previous&&normalizedText(previous.text)===normalizedText(text)&&start<previous.end-.05){removed++;continue;}
    const row={start,end,text};
    if(previous&&start<previous.start){warnings.push({start:previous.start,text,reason:'时间顺序异常，已合并到前一段，请回听。'});previous.text+=' '+text;previous.end=Math.max(previous.end,end);continue;}
    if(normalizedText(text).length/(end-start)>18||original.uncertain){warnings.push({start,text,reason:'识别或时间定位存疑，建议回听。'});}
    segments.push(row);
  }
  if(removed)warnings.unshift({start:0,text:'',reason:`已过滤 ${removed} 段零时长或重叠的重复识别。真实时间不同的重复表达会保留。`});
  return {segments,warnings};
}
