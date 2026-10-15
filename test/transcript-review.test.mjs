import {test} from 'node:test';
import assert from 'node:assert/strict';
import {transcriptReference} from '../public/transcript-review.mjs';
test('字幕与长语音段落对照：标点差异不报警，错字提示回听',()=>{
  const r={transcriptSource:'ocr-local',audioSegments:[{start:0,end:19,text:'真的不要执着于眼前的好坏。当下发生的一切，未必就是真的好。'}]};
  assert.equal(transcriptReference(r,{start:.5,end:3,text:'真的不要执着于眼前的好坏'}).differs,false);
  assert.equal(transcriptReference(r,{start:.5,end:3,text:'真的不要执着于腿前的好坏'}).differs,true);
  assert.equal(transcriptReference(r,{start:20,end:21,text:'眼前的好坏'}).text,'');
});
