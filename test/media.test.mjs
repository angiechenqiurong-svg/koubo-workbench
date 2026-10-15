import {test} from 'node:test';
import assert from 'node:assert/strict';
import {videoLink,resolvePlatformLink,publicMediaURL,anyToCopy} from '../media.mjs';
test('四平台分享链接保持必要参数，按平台和分P去重',()=>{
  assert.equal(videoLink('复制打开抖音 https://v.douyin.com/Test/').platform,'douyin');
  assert.equal(videoLink('https://www.bilibili.com/video/BV13x41117TL?p=2').sourceKey,'bilibili:BV13x41117TL:p2');
  assert.equal(videoLink('https://youtu.be/jNQXAC9IVRw?t=1').sourceKey,'youtube:jNQXAC9IVRw');
  const xhs=videoLink('分享文字 https://www.xiaohongshu.com/discovery/item/abc123?xsec_token=test-only-not-secret&xsec_source=pc_share');
  assert.equal(xhs.sourceKey,'xiaohongshu:abc123');assert.equal(xhs.url.searchParams.get('xsec_token'),'test-only-not-secret');
  for(const url of ['https://www.youtube.com.evil.invalid/watch?v=a','https://user:pass@www.youtube.com/watch?v=a','https://127.0.0.1:4317/','https://www.youtube.com/playlist?list=test'])assert.throws(()=>videoLink(url));
});
test('短链接正常跳转；拒绝跳转到其他平台或内网',async()=>{
  const link=videoLink('https://b23.tv/test');
  const resolved=await resolvePlatformLink(link,{request:async u=>u.hostname==='b23.tv'?new Response('',{status:302,headers:{Location:'https://www.bilibili.com/video/BV13x41117TL'}}):new Response('')});
  assert.equal(resolved.sourceKey,'bilibili:BV13x41117TL:p1');
  await assert.rejects(resolvePlatformLink(link,{request:async()=>new Response('',{status:302,headers:{Location:'https://127.0.0.1/private'}})}));
  await assert.rejects(publicMediaURL('http://127.0.0.1/private'));
  await assert.rejects(publicMediaURL('https://localhost/private'));
});
test('可选服务按官方任务协议轮询，不在未启用时提交',async()=>{
  const link=videoLink('https://youtu.be/jNQXAC9IVRw'),settings={parserEnabled:true,parserKey:'test-key',parserSecret:'test-secret'};
  const requests=[];let polls=0;
  const result=await anyToCopy(link,settings,'',()=>{},{pause:async()=>{},request:async(url,options)=>{
    requests.push({url,options});return new Response(JSON.stringify({code:200,data:options.method==='POST'?'task-1':++polls===1?{status:'WAITING'}:{status:'SUCCESS',taskId:'task-1',textContent:'测试文案',videoUrl:'https://example.com/test.mp4'}}));
  }});
  assert.equal(result.textContent,'测试文案');assert.equal(requests.length,3);assert.equal(requests[0].options.headers['X-API-Secret'],'test-secret');
  await assert.rejects(anyToCopy(link,{},'',()=>{},{request:async()=>{throw Error('不应提交');}}),/配置/);
});
