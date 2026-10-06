import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shareURL,videoID,importedDouyin,parsePage,resolveDouyin,downloadDouyin,validateRemote} from '../douyin.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const id='7000000000000000001';
const item={aweme_id:id,desc:'测试标题，不是产品样例',author:{nickname:'测试作者'},video:{play_addr:{url_list:['https://v-test.douyinvod.com/video.mp4']}}};
const html='<script>window._ROUTER_DATA = '+JSON.stringify({loaderData:{page:{videoInfoRes:{item_list:[item]}}}})+'</script>';
test('短链接未解析时不会误匹配没有抖音编号的本地素材',()=>{
  const records=[{id:'local-file'},{id:'downloaded',douyinId:id}];
  assert.equal(importedDouyin(records,undefined),undefined);
  assert.equal(importedDouyin(records,null),undefined);
  assert.equal(importedDouyin(records,'1111111111111111111'),undefined);
  assert.equal(importedDouyin(records,id).id,'downloaded');
});
test('分享文字、短链接、视频网址解析及域名限制',async()=>{
  const u=shareURL('复制打开抖音，看看【测试作者的作品】 https://v.douyin.com/TestShare/');assert.equal(u.hostname,'v.douyin.com');
  assert.equal(videoID(shareURL('https://www.douyin.com/video/'+id)),id);
  assert.equal(videoID(shareURL('https://www.douyin.com/?modal_id='+id)),id);
  assert.throws(()=>shareURL('https://v.douyin.com.evil.invalid/a'));
  assert.throws(()=>shareURL('https://127.0.0.1/internal'));
  await assert.rejects(validateRemote('https://evil.invalid/video.mp4',true));
  assert.equal(parsePage(html,id).desc,item.desc);assert.equal(parsePage(html,'1111111111111111111'),null);
});
test('短链接跳转、真实结构解析、网页窗口辅助与失败反馈',async()=>{
  let called=0;const request=async()=>({url:new URL('https://www.iesdouyin.com/share/video/'+id+'/'),response:new Response(html)});
  const info=await resolveDouyin('https://v.douyin.com/test/',()=>{},{request});assert.equal(info.id,id);assert.equal(info.author,'测试作者');
  const empty=async()=>({response:new Response('<html>没有视频信息</html>')});
  const fallback=await resolveDouyin('https://www.douyin.com/video/'+id,()=>{},{request:empty,browser:async url=>{called++;assert.equal(url,info.sourceUrl);return{playUrl:info.playUrl,title:'网页测试标题'};}});assert.equal(called,1);assert.equal(fallback.title,'网页测试标题');
  await assert.rejects(resolveDouyin(info.sourceUrl,()=>{},{request:empty}),/没有返回/);
});
test('下载数据完整性和大小限制',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'koubo-download-test-'));try{const file=path.join(temp,'video.mp4');
  const hash=await downloadDouyin({playUrl:item.video.play_addr.url_list[0],sourceUrl:'https://www.douyin.com/video/'+id},file,()=>{},{request:async()=>({response:new Response('fixture',{headers:{'content-length':'7'}})})});assert.equal((await fs.readFile(file)).toString(),'fixture');assert.equal(hash.length,64);
  await assert.rejects(downloadDouyin({playUrl:'x'},file,()=>{},{request:async()=>({response:new Response('fixture',{headers:{'content-length':'10'}})})}),/不完整/);
  await assert.rejects(downloadDouyin({playUrl:'x'},file,()=>{},{request:async()=>({response:new Response('fixture',{headers:{'content-length':String(501*1024*1024)}})})}),/500MB/);
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});
