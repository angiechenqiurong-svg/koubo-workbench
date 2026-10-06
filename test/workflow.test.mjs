import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import http from 'node:http';
import {fileURLToPath} from 'node:url';

import {FFMPEG} from '../runtime.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('真实视频导入、持久保存、证据校验与 AI 接口流程',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'koubo-test-'));
  let child;let token;
  const port=4318;const apiPort=4319;const url=`http://127.0.0.1:${port}`;
  const video=path.join(temp,'fixture.mp4');
  execFileSync(FFMPEG,['-v','error','-f','lavfi','-i','color=c=navy:s=320x180:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',video]);
  let audioSeen=false;
  const api=http.createServer(async(req,res)=>{let chunks=[];for await(const c of req)chunks.push(c);const b=Buffer.concat(chunks);res.setHeader('Content-Type','application/json');if(req.url==='/v1/audio/transcriptions'){audioSeen=b.includes(Buffer.from('audio/mpeg'))&&b.includes(Buffer.from('whisper-1'));res.end(JSON.stringify({segments:[{start:0,end:1.9,text:'这是测试专用口播文案。'}]}));}else{const body=JSON.parse(b),input=JSON.parse(body.messages[1].content);const output=input.profile?{openings:['测试开头一','测试开头二','测试开头三'],outline:['测试提纲'],script:'测试专用生成稿，不能用于产品样例。',missing:[]}:{materialId:input.materialId,topic:'测试选题',audience:'测试观众',conflict:'测试矛盾',viewpoint:'测试观点',template:'测试结构',outline:[{segmentId:input.segments[0].id,role:'开头',explanation:'仅用于测试的分析。'}],techniques:['测试技巧'],claims:[],ideas:['测试方向']};res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}));}});
  await new Promise(resolve=>api.listen(apiPort,'127.0.0.1',resolve));
  async function start(){child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,KOUBO_PORT:String(port),KOUBO_DATA_DIR:path.join(temp,'data'),KOUBO_SKIP_SAMPLES:'1'},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server start timeout')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(Error('server exited '+code));});});const b=await get('/api/bootstrap');token=b.token;return b;}
  async function stop(){if(!child||child.exitCode!==null)return;const p=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await p;}
  async function get(p){const r=await fetch(url+p);assert.equal(r.status,200);return r.json();}
  async function post(p,body,expected=200){const r=await fetch(url+p,{method:'POST',headers:{'Content-Type':'application/json','X-Koubo-Token':token},body:JSON.stringify(body)});assert.equal(r.status,expected,await r.clone().text());return r.json();}
  async function waitJob(id){for(let i=0;i<100;i++){const r=await get(`/api/records/${id}`);if(r.job.state!=='running')return r;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('job timeout');}
  t.after(async()=>{await stop();await new Promise(resolve=>api.close(resolve));await fs.rm(temp,{recursive:true,force:true});});
  assert.equal((await start()).records.length,0);
  assert.equal(typeof (await get('/api/capabilities')).localSpeech,'boolean');
  await post('/api/imports',{text:'这不是视频链接'},400);
  await post('/api/imports',{text:'https://example.com/video/123'},400);
  assert.equal((await get('/api/imports')).length,0);
  const bytes=await fs.readFile(video);
  const upload=async()=>{const r=await fetch(url+'/api/upload',{method:'POST',headers:{'X-Koubo-Token':token,'X-Filename':encodeURIComponent('测试素材.mp4'),'Content-Type':'application/octet-stream'},body:bytes});assert.ok([200,201].includes(r.status));return r.json();};
  const first=await upload(),id=first.record.id;
  assert.ok(first.record.duration>=2);assert.equal(first.record.sourcePath,undefined);
  assert.equal((await upload()).duplicate,true);
  const range=await fetch(url+`/api/records/${id}/media`,{headers:{Range:'bytes=0-99'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,100);
  const download=await fetch(url+`/api/records/${id}/download`);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/attachment/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  await post(`/api/records/${id}/transcribe`,{},503);
  const blocked=await fetch(url+`/api/records/${id}/draft`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(blocked.status,403);
  await post(`/api/records/${id}/transcript`,{segments:[{start:9,end:10,text:'invalid'}]},400);
  await post(`/api/records/${id}/transcript`,{segments:[{start:0,end:1,text:'真实保存的测试文案'}],reviewed:true});
  let r=await get(`/api/records/${id}`);
  const analysis={materialId:id,topic:'测试选题',audience:'测试观众',conflict:'测试矛盾',viewpoint:'测试观点',template:'测试结构',outline:[{segmentId:'not-real',role:'开头',explanation:'错误证据'}],techniques:[],claims:[],ideas:[]};
  await post(`/api/records/${id}/import-analysis`,{revision:r.revision,result:analysis},502);
  analysis.outline[0].segmentId='s0';await post(`/api/records/${id}/import-analysis`,{revision:r.revision,result:analysis});
  r=await get(`/api/records/${id}`);assert.equal(r.analysis.outline[0].quote,'真实保存的测试文案');assert.equal(r.analysisSource,'chatgpt');
  await post(`/api/records/${id}/transcript`,{segments:[{start:0,end:1,text:'修改后的测试文案'}],reviewed:true});
  assert.equal((await get(`/api/records/${id}`)).analysisStale,true);
  await post(`/api/records/${id}/import-analysis`,{revision:r.revision,result:analysis},409);
  const draft={topic:'测试选题',viewpoint:'测试观点',experience:'仅用于测试的一次操作',manualScript:'已保存的修改稿'};
  await post(`/api/records/${id}/draft`,draft);
  const exp=await fetch(url+`/api/records/${id}/export`);assert.match(await exp.text(),/已保存的修改稿/);
  await stop();await start();assert.equal((await get(`/api/records/${id}`)).draft.manualScript,draft.manualScript);
  await post('/api/settings',{baseUrl:`http://127.0.0.1:${apiPort}/v1`,apiKey:'test-only-not-a-real-key',chatModel:'test-only-model',transcriptionModel:'whisper-1'});
  assert.equal((await get('/api/settings')).apiKey,undefined);
  const mode=(await fs.stat(path.join(temp,'data/settings.json'))).mode&0o777;assert.equal(mode,0o600);
  await post(`/api/records/${id}/transcribe`,{});r=await waitJob(id);assert.equal(r.job.state,'done');assert.equal(r.transcriptSource,'audio');assert.ok(audioSeen);assert.equal(r.segments[0].text,'这是测试专用口播文案。');
  await post(`/api/records/${id}/analyze`,{});r=await waitJob(id);assert.equal(r.job.state,'done');assert.equal(r.analysisSource,'ai');assert.equal(r.analysisStale,false);
  await post(`/api/records/${id}/create`,draft);r=await waitJob(id);assert.equal(r.job.state,'done');assert.equal(r.creationVersions.length,1);
});
