import {test} from 'node:test';
import assert from 'node:assert/strict';
import {subtitleSegments} from '../subtitles.mjs';
const row=(text,y=.5)=>({text,confidence:.98,x:.2,y,w:.3,h:.05});
test('字幕初稿去除常驻文字，保留动态原句和近似时间',()=>{
  const frames=Array.from({length:10},(_,i)=>({time:i*.5,items:[row('固定的标题',.9),row(i<5?'认真过好今天的生活':'允许自己慢慢改变')]}));
  const r=subtitleSegments(frames,5,.5,'认真过好今天的生活允许自己慢慢改变');
  assert.equal(r.length,2);assert.equal(r[0].text,'认真过好今天的生活');assert.equal(r[1].start,2.5);assert.ok(!r.some(s=>s.text.includes('固定')));
});
test('画面字幕不足时保留音频识别，不把标题当作全文',()=>{
  const frames=Array.from({length:10},(_,i)=>({time:i*.5,items:[row('永远不变的固定标题')]}));
  assert.equal(subtitleSegments(frames,5,.5,'这是音频中的实际内容'),null);
});
test('合并短暂识别抖动，保留稳定原句',()=>{
  const frames=Array.from({length:10},(_,i)=>({time:i*.5,items:[row(i===4?'认真过好今天的生话':'认真过好今天的生活')]}));
  // A completely constant scene is intentionally rejected as a subtitle track;
  // add a second actual caption so the first sentence has a temporal consensus.
  frames.splice(6,4,...Array.from({length:4},(_,i)=>({time:(i+6)*.5,items:[row('允许自己慢慢改变')]})));
  const r=subtitleSegments(frames,5,.5,'认真过好今天的生活允许自己慢慢改变');assert.equal(r.length,2);assert.equal(r[0].text,'认真过好今天的生活');
});
