import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT,createLocalJWKSet} from 'jose';
import {ChatGPTConnection,verifyOpenAIIdentity,readResponsesJSON} from '../chatgpt.mjs';
import {chatJSON} from '../ai.mjs';
const permission='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const resource='https://api.openai.com/v1',issuer='https://auth.openai.com';
const pair=await generateKeyPair('RS256');const publicJWK=await exportJWK(pair.publicKey);publicJWK.kid='test';
const jwks=createLocalJWKSet({keys:[publicJWK]});
async function jwt({clientId='oaiapp_test',nonce='nonce',sub='test-sub',iss=issuer,expired=false}={}){return new SignJWT({nonce,email:'test@example.test'}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(iss).setAudience(clientId).setSubject(sub).setIssuedAt().setExpirationTime(expired?Math.floor(Date.now()/1000)-100:'1h').sign(pair.privateKey);}
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const events=values=>new Response(values.map(v=>'data: '+JSON.stringify(v)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'koubo-chatgpt-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let now=Date.now(),nonce='',scope=permission,expires=3600,sub='test-sub',refreshCount=0,tokenCalls=0,responseBody;
  const calls=[];
  const service=await new ChatGPTConnection(directory,{now:()=>now,verifyImpl:(token,expected)=>verifyOpenAIIdentity(token,expected,jwks),fetchImpl:async(url,options={})=>{
    calls.push({url,options});if(url===resource+'/models')return json({models:[{slug:'hidden',display_name:'隐藏',visibility:'hidden'},{slug:'gpt-6-luna',display_name:'GPT 6 Luna',visibility:'list'},{slug:'other-model',display_name:'另一个模型',visibility:'list'}]});
    if(url===issuer+'/api/accounts/oauth/token'){
      tokenCalls++;const form=new URLSearchParams(options.body);assert.equal(form.get('resource'),resource);assert.notEqual(form.get('client_id'),'dynamic_agent_client');
      if(form.get('grant_type')==='refresh_token'){refreshCount++;await new Promise(r=>setTimeout(r,10));return json({access_token:'test-only-renewed-access',refresh_token:'test-only-rotated-refresh',token_type:'Bearer',expires_in:3600,scope});}
      const challenge=createHash('sha256').update(form.get('code_verifier')).digest('base64url');assert.equal(challenge,new URL(service.startURL).searchParams.get('code_challenge'));
      return json({access_token:'test-only-access',refresh_token:'test-only-refresh',id_token:await jwt({nonce,sub,clientId:form.get('client_id')}),token_type:'Bearer',expires_in:expires,scope});
    }
    if(url===resource+'/responses'){responseBody=JSON.parse(options.body);return events([{type:'response.output_text.delta',delta:'{"ok":true}'},{type:'response.completed',response:{status:'completed'}}]);}
    if(url.endsWith('/oauth/revoke'))return new Response(null,{status:200});throw Error('Unexpected request');
  }}).load();
  const start=async(extra={})=>{const result=await service.start({consent:true,...extra},'http://127.0.0.1:4317/auth/callback');service.startURL=result.url;nonce=new URL(result.url).searchParams.get('nonce');return result;};
  const finish=async(result,extra={})=>service.callback(new URLSearchParams({state:new URL(result.url).searchParams.get('state'),code:'test-only-code',client_id:'oaiapp_test',...extra}),result.binding);
  return {service,calls,start,finish,directory,setScope:v=>scope=v,setExpires:v=>expires=v,setSub:v=>sub=v,advance:ms=>now+=ms,get refreshCount(){return refreshCount;},get tokenCalls(){return tokenCalls;},get responseBody(){return responseBody;}};
}

test('身份令牌校验签名、issuer、audience、有效期和 nonce',async()=>{
  assert.equal((await verifyOpenAIIdentity(await jwt(),{clientId:'oaiapp_test',nonce:'nonce'},jwks)).sub,'test-sub');
  for(const [options,expected] of [[{iss:'https://bad.example'},{clientId:'oaiapp_test',nonce:'nonce'}],[{expired:true},{clientId:'oaiapp_test',nonce:'nonce'}],[{clientId:'wrong'},{clientId:'oaiapp_test',nonce:'nonce'}],[{nonce:'wrong'},{clientId:'oaiapp_test',nonce:'nonce'}]])await assert.rejects(verifyOpenAIIdentity(await jwt(options),expected,jwks));
  const bad=await generateKeyPair('RS256');const token=await new SignJWT({nonce:'nonce'}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience('oaiapp_test').setSubject('test-sub').setIssuedAt().setExpirationTime('1h').sign(bad.privateKey);await assert.rejects(verifyOpenAIIdentity(token,{clientId:'oaiapp_test',nonce:'nonce'},jwks));
});

test('首次授权先取得用户存储同意，PKCE、state、浏览器绑定与 issued client 正确',async t=>{
  const f=await fixture(t);await assert.rejects(f.service.start({consent:false},'http://127.0.0.1:4317/auth/callback'),/同意/);await assert.rejects(fs.access(f.service.hostFile));
  const r=await f.start(),u=new URL(r.url);assert.equal(u.origin,issuer);assert.equal(u.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(u.searchParams.get('scope'),permission);assert.equal(u.searchParams.get('resource'),resource);assert.equal(u.searchParams.get('agent_name_hint'),'口播工作台');assert.match(u.searchParams.get('ext_agent_host_id'),/^urn:uuid:/);
  const state=u.searchParams.get('state');await assert.rejects(f.service.callback(new URLSearchParams({state,code:'test',client_id:'oaiapp_test'}),'wrong-cookie'),/校验/);assert.equal(f.tokenCalls,0);
  await f.finish(r);assert.equal(f.service.publicState().connected,true);assert.equal(f.service.publicState().model,'gpt-6-luna');assert.equal(f.service.publicState().models.length,2);
  assert.equal((await fs.stat(f.service.file)).mode&0o777,0o600);assert.equal((await fs.stat(f.directory)).mode&0o777,0o700);
  const safe=JSON.stringify(f.service.publicState());for(const privateValue of ['test-only-access','test-only-refresh',f.service.profile().id_token])assert.equal(safe.includes(privateValue),false);
  await assert.rejects(f.finish(r),/校验/);assert.equal(f.tokenCalls,1);
});

test('重新登录复用注册；取消、账户错误和权限不足不伪装为连接成功',async t=>{
  const f=await fixture(t);await f.finish(await f.start());const old=f.service.profile(),id=old.id,host=f.service.hostId;
  let r=await f.start();assert.equal(new URL(r.url).searchParams.get('client_id'),'oaiapp_test');assert.equal(new URL(r.url).searchParams.has('agent_name_hint'),false);assert.equal(new URL(r.url).searchParams.has('id_token_hint'),false);assert.equal(f.service.hostId,host);
  await assert.rejects(f.finish(r,{error:'access_denied'}),/未完成/);assert.equal(f.service.profile().id,id);assert.equal(f.service.profile().access_token,old.access_token);
  r=await f.start();await assert.rejects(f.finish(r,{client_id:'oaiapp_changed'}),/不匹配/);assert.equal(f.service.profile().id,id);
  f.setSub('different-sub');r=await f.start();await assert.rejects(f.finish(r),/身份校验/);assert.equal(f.service.profile().subject,'test-sub');
  f.setScope('openid profile email');r=await f.start({newAccount:true});await f.finish(r,{client_id:'oaiapp_second'});assert.equal(f.service.publicState().connected,false);assert.equal(f.service.publicState().accounts.length,2);assert.throws(()=>f.service.config(),/套餐授权/);
  await f.service.select(id);assert.equal(f.service.publicState().connected,true);
});

test('凭据重启后续用，刷新串行并保存轮换 token；退出清除凭据但保留注册',async t=>{
  const f=await fixture(t);f.setExpires(60);await f.finish(await f.start());const id=f.service.profile().id;
  const keys=await Promise.all([f.service.access(id),f.service.access(id),f.service.access(id)]);assert.equal(f.refreshCount,1);assert.equal(new Set(keys).size,1);assert.equal(f.service.profile().refresh_token,'test-only-rotated-refresh');
  const reloaded=await new ChatGPTConnection(f.directory).load();assert.equal(reloaded.publicState().connected,true);assert.equal(reloaded.profile().client_id,'oaiapp_test');
  const result=await f.service.disconnect(id);assert.equal(result.revoked,true);assert.equal(result.connected,false);assert.equal(f.service.profile().client_id,'oaiapp_test');const disk=JSON.parse(await fs.readFile(f.service.file,'utf8'));assert.equal(disk.profiles[0].access_token,'');assert.equal(disk.profiles[0].refresh_token,'');assert.equal(disk.profiles[0].id_token,'');
});

test('套餐调用使用 Responses 及已授权模型，不要求 API 密钥或自动改换计费路径',async t=>{
  const f=await fixture(t);await f.finish(await f.start());const result=await chatJSON('只返回 JSON',{test:'connection'},f.service.config());assert.deepEqual(result,{ok:true});
  assert.equal(f.responseBody.model,'gpt-6-luna');assert.equal(f.responseBody.store,false);assert.equal(f.responseBody.stream,true);assert.equal(f.responseBody.instructions,'只返回 JSON');assert.ok(Array.isArray(f.responseBody.input));assert.equal(f.responseBody.input[0].role,'user');
  await assert.rejects(f.service.setModel('not-available'),/可用/);await f.service.setModel('other-model');assert.equal(f.service.config().chatModel,'other-model');
});

test('事件流需要完成事件，处理跨块 UTF-8 / CRLF，拒绝中断、截断和额度失败',async()=>{
  const raw='data: '+JSON.stringify({type:'response.output_text.delta',delta:'{"结果":"正确"}'})+'\r\n\r\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\r\n\r\n';const bytes=new TextEncoder().encode(raw);
  const stream=new ReadableStream({start(c){for(let i=0;i<bytes.length;i++)c.enqueue(bytes.slice(i,i+1));c.close();}});assert.deepEqual(await readResponsesJSON(new Response(stream)),{结果:'正确'});
  await assert.rejects(readResponsesJSON(events([{type:'response.output_text.delta',delta:'{"ok":true}'}])),/中断/);
  await assert.rejects(readResponsesJSON(events([{type:'response.output_text.delta',delta:'{"ok":true}'},{type:'response.incomplete'}])),/未完成/);
  await assert.rejects(readResponsesJSON(events([{type:'response.output_text.delta',delta:'{"ok":true}'},{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded',message:'private-test-text'}}}])),e=>/额度/.test(e.message)&&!e.message.includes('private-test-text'));
});

test('只有终止刷新错误清除授权，临时服务错误保留连接和注册',async t=>{
  const f=await fixture(t);await f.finish(await f.start());const p=f.service.profile(),original=f.service.fetch;p.expiresAt=Date.now()+1000;
  f.service.fetch=async(url,opts)=>url.endsWith('/oauth/token')?new Response(JSON.stringify({error:'server_error'}),{status:503}):original(url,opts);
  await assert.rejects(f.service.access(p.id));assert.equal(f.service.publicState().connected,true);assert.equal(p.refresh_token,'test-only-refresh');
  f.service.fetch=async(url,opts)=>url.endsWith('/oauth/token')?new Response(JSON.stringify({error:'invalid_refresh_token'}),{status:400}):original(url,opts);
  await assert.rejects(f.service.access(p.id));assert.equal(f.service.publicState().connected,false);assert.equal(p.refresh_token,'');assert.equal(p.client_id,'oaiapp_test');
});

test('新登录操作取消尚在交换中的旧回调，旧结果不覆盖当前账户或新等待状态',async t=>{
  const f=await fixture(t);await f.finish(await f.start());const id=f.service.profile().id,old=await f.start(),original=f.service.fetch;let release,arrived;const held=new Promise(r=>release=r),started=new Promise(r=>arrived=r);
  f.service.fetch=async(url,opts)=>{const response=await original(url,opts);if(url.endsWith('/oauth/token')){arrived();await held;}return response;};
  const completing=f.finish(old);await started;await f.start({newAccount:true});assert.equal(f.service.publicState().attempt.state,'pending');release();await assert.rejects(completing,/新的操作取消/);assert.equal(f.service.profile().id,id);assert.equal(f.service.publicState().attempt.state,'pending');
});

test('套餐请求连接失败只有限重连，流已打开后中断不重复发送',async t=>{
  const f=await fixture(t);await f.finish(await f.start());const original=f.service.fetch,delays=[],progress=[];f.service.wait=async ms=>delays.push(ms);let attempts=0;
  f.service.fetch=async(url,opts)=>{if(url.endsWith('/responses')&&++attempts<3)throw Object.assign(new TypeError('test-only-private-text'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});return original(url,opts);};
  const result=await f.service.config().complete('JSON',{test:'connection'},{onProgress:s=>progress.push(s)});assert.deepEqual(result,{ok:true});assert.equal(attempts,3);assert.deepEqual(delays,[1000,2000]);assert.equal(progress.length,2);
  attempts=0;f.service.fetch=async()=>{attempts++;throw Object.assign(new TypeError('test-only-private-text'),{cause:{code:'ECONNRESET'}});};await assert.rejects(f.service.config().complete('JSON',{}),e=>e.details.attempts===3&&!e.message.includes('private-text'));assert.equal(attempts,3);
  attempts=0;f.service.fetch=async()=>{attempts++;return events([{type:'response.output_text.delta',delta:'{"ok":true}'}]);};await assert.rejects(f.service.config().complete('JSON',{}),/中断/);assert.equal(attempts,1);
});
