import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import http from 'node:http';
import {fileURLToPath} from 'node:url';

import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {FFMPEG} from '../runtime.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('真实视频导入、持久保存、证据校验与 AI 接口流程',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'koubo-test-'));
  let child;let token;
  const port=4318;const apiPort=4319;const url=`http://127.0.0.1:${port}`;
  const video=path.join(temp,'fixture.mp4');
  execFileSync(FFMPEG,['-v','error','-f','lavfi','-i','color=c=navy:s=320x180:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',video]);
  const interceptor=path.join(temp,'mock-provider-fetch.mjs');
  await fs.writeFile(interceptor,`const realFetch=globalThis.fetch;globalThis.fetch=(url,opts)=>{const s=String(url);if(s.startsWith('https://auth.openai.com/'))return realFetch('http://127.0.0.1:${apiPort}/auth/'+s.slice('https://auth.openai.com/'.length),opts);if(s.startsWith('https://api.openai.com/v1/'))return realFetch('http://127.0.0.1:${apiPort}/chatgpt/'+s.slice('https://api.openai.com/v1/'.length),opts);if(s.startsWith('https://api.deepseek.com/'))return realFetch('http://127.0.0.1:${apiPort}/deepseek/'+s.slice('https://api.deepseek.com/'.length),opts);if(s.startsWith('https://generativelanguage.googleapis.com/v1beta/'))return realFetch('http://127.0.0.1:${apiPort}/gemini/'+s.slice('https://generativelanguage.googleapis.com/v1beta/'.length),opts);return realFetch(url,opts);};`);
  const authPair=await generateKeyPair('RS256'),authJWK=await exportJWK(authPair.publicKey);authJWK.kid='test-auth';let expectedAuthorize,authTokens=0;
  let audioSeen=false,unavailableCount=0;const providerCalls=[],progressMessages=[];
  const api=http.createServer(async(req,res)=>{
    let chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks);res.setHeader('Content-Type','application/json');
    if(req.url==='/auth/.well-known/jwks.json'){res.end(JSON.stringify({keys:[authJWK]}));return;}
    if(req.url==='/auth/api/accounts/oauth/token'){
      authTokens++;const form=new URLSearchParams(bytes.toString());assert.equal(form.get('client_id'),'oaiapp_workbench_test');assert.equal(form.get('redirect_uri'),url+'/auth/callback');assert.equal(form.get('resource'),'https://api.openai.com/v1');
      const idToken=await new SignJWT({nonce:new URL(expectedAuthorize).searchParams.get('nonce'),email:'workbench-test@example.test'}).setProtectedHeader({alg:'RS256',kid:'test-auth'}).setIssuer('https://auth.openai.com').setAudience('oaiapp_workbench_test').setSubject('test-workbench-sub').setIssuedAt().setExpirationTime('1h').sign(authPair.privateKey);
      res.end(JSON.stringify({access_token:'test-only-chatgpt-access',refresh_token:'test-only-chatgpt-refresh',id_token:idToken,expires_in:3600,token_type:'Bearer',scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'}));return;
    }
    if(req.url==='/chatgpt/models'){assert.equal(req.headers.authorization,'Bearer test-only-chatgpt-access');res.end(JSON.stringify({models:[{slug:'gpt-6-luna',display_name:'GPT 6 Luna',visibility:'list'}]}));return;}
    if(req.url==='/auth/api/accounts/oauth/revoke'){res.end('{}');return;}
    if(req.url==='/v1/audio/transcriptions'){audioSeen=bytes.includes(Buffer.from('audio/mpeg'))&&bytes.includes(Buffer.from('whisper-1'));assert.equal(req.headers.authorization,'Bearer test-only-not-a-real-key');res.end(JSON.stringify({segments:[{start:0,end:1.9,text:'这是测试专用口播文案。'}]}));return;}
    const body=JSON.parse(bytes),native=req.url.startsWith('/gemini/'),plan=req.url==='/chatgpt/responses',input=JSON.parse(plan?body.input[0].content:native?body.contents[0].parts[0].text:body.messages[1].content);if(plan){assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(req.headers.authorization,'Bearer test-only-chatgpt-access');}
    providerCalls.push({url:req.url,authorization:req.headers.authorization,geminiKey:req.headers['x-goog-api-key'],input});
    if(native&&unavailableCount>0){unavailableCount--;res.writeHead(503);res.end(JSON.stringify({error:{status:'UNAVAILABLE'}}));return;}
    if(native&&input.materialId){assert.deepEqual(body.generationConfig.responseSchema.properties.materialId.enum,[input.materialId]);assert.deepEqual(body.generationConfig.responseSchema.properties.outline.items.properties.segmentId.enum,input.segments.map(s=>s.id));}
    const output=input.test?{ok:true}:input.profile?{openings:['测试开头一','测试开头二','测试开头三'],outline:['测试提纲'],script:'测试专用生成稿，不能用于产品样例。',missing:[]}:{materialId:input.materialId,topic:'测试选题',audience:'测试观众',conflict:'测试矛盾',viewpoint:'测试观点',template:'测试结构',outline:[{segmentId:body.model==='bad-evidence'?'not-real':input.segments[0].id,role:'开头',explanation:'仅用于测试的分析。'}],techniques:['测试技巧'],claims:[],ideas:['测试方向']};
    if(plan){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify(output)})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\n\n');return;}
    res.end(JSON.stringify(native?{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(output)}]}}]}:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
  });
  await new Promise(resolve=>api.listen(apiPort,'127.0.0.1',resolve));
  async function start(){child=spawn(process.execPath,['--import',interceptor,'server.mjs'],{cwd:root,env:{...process.env,KOUBO_PORT:String(port),KOUBO_DATA_DIR:path.join(temp,'data'),KOUBO_SKIP_SAMPLES:'1'},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server start timeout')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(Error('server exited '+code));});});const b=await get('/api/bootstrap');token=b.token;return b;}
  async function stop(){if(!child||child.exitCode!==null)return;const p=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await p;}
  async function get(p){const r=await fetch(url+p);assert.equal(r.status,200);return r.json();}
  async function post(p,body,expected=200){const r=await fetch(url+p,{method:'POST',headers:{'Content-Type':'application/json','X-Koubo-Token':token},body:JSON.stringify(body)});assert.equal(r.status,expected,await r.clone().text());return r.json();}
  async function waitJob(id){for(let i=0;i<100;i++){const r=await get(`/api/records/${id}`);if(r.job.state!=='running')return r;progressMessages.push(r.job.message);await new Promise(resolve=>setTimeout(resolve,50));}throw Error('job timeout');}
  t.after(async()=>{await stop();await new Promise(resolve=>api.close(resolve));await fs.rm(temp,{recursive:true,force:true});});
  assert.equal((await start()).records.length,0);
  const referenceModule=await fetch(url+'/transcript-review.mjs');assert.equal(referenceModule.status,200);assert.match(referenceModule.headers.get('content-type'),/javascript/);
  const frontend=await fetch(url+'/app.js');
  assert.equal(frontend.headers.get('cache-control'),'no-store');
  const frontendSource=await frontend.text();
  for(const m of frontendSource.matchAll(/^import[^\n]+from '([^']+)'/gm)){
    const moduleResponse=await fetch(new URL(m[1],url+'/app.js'));assert.equal(moduleResponse.status,200,`前端依赖必须可加载：${m[1]}`);assert.match(moduleResponse.headers.get('content-type'),/javascript/);
  }
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
  await post(`/api/records/${id}/speech-options`,{vocabulary:'王阳明、陶渊明、丰盈'});
  assert.equal((await get(`/api/records/${id}`)).speechVocabulary,'王阳明、陶渊明、丰盈');
  await post(`/api/records/${id}/restore-transcript`,{},400);
  const draft={topic:'测试选题',viewpoint:'测试观点',experience:'仅用于测试的一次操作',manualScript:'已保存的修改稿'};
  await post(`/api/records/${id}/draft`,draft);
  const exp=await fetch(url+`/api/records/${id}/export`);assert.match(await exp.text(),/已保存的修改稿/);
  await stop();await start();assert.equal((await get(`/api/records/${id}`)).draft.manualScript,draft.manualScript);assert.equal((await get(`/api/records/${id}`)).speechVocabulary,'王阳明、陶渊明、丰盈');
  await post('/api/settings',{baseUrl:`http://127.0.0.1:${apiPort}/v1`,apiKey:'test-only-not-a-real-key',chatModel:'test-only-model',transcriptionModel:'whisper-1'});
  assert.equal((await get('/api/settings')).apiKey,undefined);
  const mode=(await fs.stat(path.join(temp,'data/settings.json'))).mode&0o777;assert.equal(mode,0o600);
  await post(`/api/records/${id}/transcribe`,{});r=await waitJob(id);assert.equal(r.job.state,'done');assert.equal(r.transcriptSource,'audio');assert.ok(audioSeen);assert.equal(r.segments[0].text,'这是测试专用口播文案。');
  await post(`/api/records/${id}/analyze`,{});r=await waitJob(id);assert.equal(r.job.state,'done');assert.equal(r.analysisSource,'ai');assert.equal(r.analysisStale,false);
  await post(`/api/records/${id}/create`,draft);r=await waitJob(id);assert.equal(r.job.state,'done');assert.equal(r.creationVersions.length,1);
  for(const provider of ['deepseek','gemini']){
    const before=providerCalls.length;
    const conf=await post('/api/settings',{provider,apiKey:provider+'-test-only-key'});
    assert.equal(conf.provider,provider);assert.equal(conf.ready,true);assert.equal(providerCalls.length,before,'保存配置不发送素材');
    const checked=await post('/api/settings/test',{});assert.equal(checked.provider,provider);assert.deepEqual(providerCalls.at(-1).input,{test:'connection'});
    await post(`/api/records/${id}/analyze`,{});r=await waitJob(id);assert.equal(r.job.state,'done');assert.equal(r.analysisProvider,provider);assert.equal(r.analysis.outline[0].quote,r.segments[0].text);
    const call=providerCalls.at(-1);if(provider==='gemini'){assert.equal(call.geminiKey,'gemini-test-only-key');assert.equal(call.authorization,undefined);assert.match(call.url,/:generateContent$/);}else{assert.equal(call.authorization,'Bearer deepseek-test-only-key');assert.equal(call.url,'/deepseek/chat/completions');}
    await post(`/api/records/${id}/create`,draft);r=await waitJob(id);assert.equal(r.job.state,'done');assert.equal(r.creationVersions[0].provider,provider);
    assert.equal(JSON.stringify(await get('/api/bootstrap')).includes(provider+'-test-only-key'),false);
  }
  const beforeRetry=providerCalls.length;unavailableCount=1;
  await post(`/api/records/${id}/analyze`,{provider:'gemini'});r=await waitJob(id);assert.equal(r.job.state,'done');assert.equal(providerCalls.length-beforeRetry,2);assert.ok(progressMessages.some(m=>/正在等待重试/.test(m)));assert.equal(r.analysisProvider,'gemini');
  await post(`/api/records/${id}/analyze`,{provider:'deepseek'});r=await waitJob(id);assert.equal(r.analysisProvider,'deepseek');assert.equal((await get('/api/settings')).provider,'gemini','本次选择不能修改默认服务');
  await post(`/api/records/${id}/analyze`,{provider:'not-supported'},400);
  await post('/api/settings',{provider:'deepseek',chatModel:'bad-evidence'});
  await post(`/api/records/${id}/analyze`,{});r=await waitJob(id);assert.equal(r.job.state,'error');assert.match(r.job.message,/不存在/);assert.equal(r.analysisProvider,'deepseek','错误证据不能覆盖已保存结果');
  await post('/api/settings',{provider:'gemini'});await stop();await start();
  const providers=await get('/api/settings');assert.equal(providers.provider,'gemini');assert.equal(providers.profiles.deepseek.hasKey,true);assert.equal(providers.profiles.openai.hasKey,true);
  await post(`/api/records/${id}/transcribe`,{});r=await waitJob(id);assert.equal(r.job.state,'done','选择 Gemini 后云端语音仍使用原来的独立接口');
  await post('/api/settings',{provider:'deepseek',clearKey:true});await post(`/api/records/${id}/analyze`,{},503);
  const callsBefore=providerCalls.length;await post(`/api/records/${id}/analyze`,{provider:'deepseek'},503);assert.equal(providerCalls.length,callsBefore,'未配置的服务不能偷偷换成其他服务');
  await post(`/api/records/${id}/analyze`,{provider:'gemini'});r=await waitJob(id);assert.equal(r.analysisProvider,'gemini');assert.equal((await get('/api/settings')).provider,'deepseek');
  assert.equal((await get('/api/settings')).profiles.gemini.hasKey,true);
  await post('/api/settings',{provider:'openai'});
  await stop();
  const savedFile=path.join(temp,'data/records',id+'.json'),saved=JSON.parse(await fs.readFile(savedFile,'utf8'));
  saved.transcriptBackup={segments:[{start:0,end:1,text:'重新识别前已经校对的文案'}],transcriptSource:'manual',timestampKind:'none',reviewed:true,audioSegments:[{start:0,end:1,text:'以前的语音初稿'}],subtitleSegments:[]};
  await fs.writeFile(savedFile,JSON.stringify(saved));await start();
  r=await post(`/api/records/${id}/restore-transcript`);
  assert.equal(r.segments[0].text,'重新识别前已经校对的文案');assert.equal(r.transcriptReviewed,true);assert.equal(r.analysisStale,true);assert.equal(r.audioSegments[0].text,'以前的语音初稿');assert.equal(r.transcriptBackup,undefined);
  await post(`/api/records/${id}/restore-transcript`,{},400);

  await post('/api/chatgpt/start',{consent:false},400);
  const deniedLogin=await fetch(url+'/api/chatgpt/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"consent":true}'});assert.equal(deniedLogin.status,403);
  const loginResponse=await fetch(url+'/api/chatgpt/start',{method:'POST',headers:{'Content-Type':'application/json','X-Koubo-Token':token},body:'{"consent":true}'});assert.equal(loginResponse.status,200);
  const login=await loginResponse.json();expectedAuthorize=login.url;assert.match(loginResponse.headers.get('set-cookie'),/HttpOnly/);const cookie=loginResponse.headers.get('set-cookie').split(';')[0];
  const callback='/auth/callback?'+new URLSearchParams({state:new URL(login.url).searchParams.get('state'),code:'test-only-code',client_id:'oaiapp_workbench_test'});
  const invalidCallback=await fetch(url+callback,{redirect:'manual'});assert.equal(invalidCallback.status,302);assert.equal((await get('/api/chatgpt/status')).connected,false);assert.equal(authTokens,0);
  const callbackResponse=await fetch(url+callback,{headers:{Cookie:cookie},redirect:'manual'});assert.equal(callbackResponse.status,302);assert.equal(callbackResponse.headers.get('location'),'/auth/chatgpt-complete');
  const account=await get('/api/chatgpt/status');assert.equal(account.connected,true);assert.equal(account.model,'gpt-6-luna');assert.equal(authTokens,1);
  const safeAccount=JSON.stringify(await get('/api/bootstrap'));assert.equal(safeAccount.includes('test-only-chatgpt-access'),false);assert.equal(safeAccount.includes('test-only-chatgpt-refresh'),false);
  assert.equal((await get('/api/settings')).profiles.chatgpt.hasKey,false);assert.equal((await get('/api/settings')).profiles.chatgpt.hasAuth,true);
  await post('/api/chatgpt/test',{});assert.deepEqual(providerCalls.at(-1).input,{test:'connection'});
  await post(`/api/records/${id}/analyze`,{provider:'chatgpt'});r=await waitJob(id);assert.equal(r.job.state,'done');assert.equal(r.analysisProvider,'chatgpt');assert.equal(r.analysisModel,'gpt-6-luna');assert.equal(r.analysis.outline[0].quote,r.segments[0].text);assert.equal((await get('/api/settings')).provider,'openai');
  await post('/api/settings',{provider:'chatgpt',chatModel:'gpt-6-luna'});assert.equal((await get('/api/settings')).ready,true);
  await post(`/api/records/${id}/create`,draft);r=await waitJob(id);assert.equal(r.creationVersions[0].provider,'chatgpt');
  await stop();await start();assert.equal((await get('/api/settings')).profiles.chatgpt.hasAuth,true);assert.equal((await get('/api/settings')).profiles.openai.hasKey,true);
  const disconnected=await post('/api/chatgpt/disconnect',{id:account.activeId});assert.equal(disconnected.revoked,true);assert.equal(disconnected.settings.profiles.chatgpt.ready,false);
  const afterDisconnect=providerCalls.length;await post(`/api/records/${id}/analyze`,{provider:'chatgpt'},503);assert.equal(providerCalls.length,afterDisconnect);await post('/api/settings',{provider:'openai'});

  await post('/api/settings',{baseUrl:`http://127.0.0.1:${apiPort}/v1`,parserEnabled:true,parserKey:'test-parser-key',parserSecret:'test-parser-secret'});
  const safe=await get('/api/settings');assert.equal(safe.hasParserKey,true);assert.equal(safe.parserKey,undefined);assert.equal(safe.parserSecret,undefined);
  await stop();const retryRecord=JSON.parse(await fs.readFile(savedFile,'utf8'));retryRecord.sourceKey='youtube:TEST0000001';await fs.writeFile(savedFile,JSON.stringify(retryRecord));
  const failed={id:'retry-test',state:'error',message:'测试失败',sourceUrl:'https://www.youtube.com/watch?v=TEST0000001',originalText:'完整测试分享 https://www.youtube.com/watch?v=TEST0000001',extract:false,goAnalyze:true,createdAt:new Date().toISOString()};await fs.writeFile(path.join(temp,'data/imports/retry-test.json'),JSON.stringify(failed));
  await start();const retry=await post('/api/imports/retry-test/retry',{},202);assert.equal(retry.originalText,failed.originalText);assert.equal(retry.retryOf,'retry-test');assert.equal(retry.sourcePlatform,'youtube');
  for(let i=0;i<50;i++){const jobs=await get('/api/imports'),done=jobs.find(j=>j.id===retry.id);if(done.state==='done'){assert.equal(done.recordId,id);break;}if(i===49)throw Error('retry did not finish');await new Promise(resolve=>setTimeout(resolve,20));}

});

