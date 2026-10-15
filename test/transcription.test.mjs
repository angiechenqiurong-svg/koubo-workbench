import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanTranscription} from '../transcription.mjs';
test('清理零时长与重叠重复，保留真正不同时间的重复表达',()=>{
  const input=[{start:0,end:2,text:'我想休息'},{start:1,end:2,text:'我想休息'},{start:2,end:2,text:'错误重复'},{start:3,end:4,text:'我想休息'},{start:4,end:5,text:'我不想休息'}];
  const result=cleanTranscription(input,5);assert.deepEqual(result.segments.map(s=>s.text),['我想休息','我想休息','我不想休息']);assert.match(result.warnings[0].reason,/2 段/);
});
test('异常时间修复和低置信度提示不猜改原句',()=>{
  const result=cleanTranscription([{start:2,end:4,text:'原句'},{start:1,end:3,text:'后到的原句'},{start:4,end:8,text:'仍需核对的名字',uncertain:true}],6);
  assert.equal(result.segments[0].text,'原句 后到的原句');assert.equal(result.segments[1].end,6);assert.equal(result.warnings.length,2);
});
