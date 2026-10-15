import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAISettings,updateAISettings,publicAISettings,textConfig,chatJSON,analysisSchema} from '../ai.mjs';

test('旧配置迁移、三家密钥隔离、切换保留与单独清除',()=>{
  let s=normalizeAISettings({baseUrl:'https://old.example/v1',apiKey:'legacy-key',chatModel:'legacy-model',transcriptionModel:'whisper-1'});
  assert.equal(textConfig(s).apiKey,'legacy-key');
  assert.throws(()=>textConfig(s,'unsupported'),/请选择/);
  s=updateAISettings(s,{provider:'deepseek'});assert.equal(textConfig(s).apiKey,'');assert.equal(publicAISettings(s).ready,false);
  s=updateAISettings(s,{provider:'deepseek',apiKey:'deepseek-key',chatModel:'deepseek-flash',baseUrl:'https://wrong.example'});
  assert.equal(textConfig(s).baseUrl,'https://api.deepseek.com');assert.equal(s.apiKey,'legacy-key');
  s=updateAISettings(s,{provider:'gemini',apiKey:'gemini-key',chatModel:'models/gemini-3.8-flash'});
  assert.equal(textConfig(s).chatModel,'gemini-3.8-flash');assert.equal(s.apiKey,'legacy-key');
  s=normalizeAISettings(JSON.parse(JSON.stringify(s)));
  const safe=publicAISettings(s);assert.equal(safe.provider,'gemini');assert.equal(safe.transcriptionReady,true);
  for(const key of ['legacy-key','deepseek-key','gemini-key'])assert.equal(JSON.stringify(safe).includes(key),false);
  s=updateAISettings(s,{provider:'deepseek',apiKey:''});assert.equal(textConfig(s).apiKey,'deepseek-key');
  s=updateAISettings(s,{provider:'deepseek',clearKey:true});assert.equal(textConfig(s).apiKey,'');
  s=updateAISettings(s,{provider:'gemini'});assert.equal(textConfig(s).apiKey,'gemini-key');
  assert.throws(()=>updateAISettings(s,{provider:'invalid'}),/请选择/);
  assert.throws(()=>updateAISettings(s,{provider:'openai',baseUrl:'https://host/v1?key=secret'}),/查询参数/);
  assert.throws(()=>updateAISettings(s,{provider:'gemini',chatModel:'../bad?key=secret'}),/模型名称/);
});

test('DeepSeek 请求认证、JSON 模式及返回解析',async()=>{
  const config=textConfig(updateAISettings(normalizeAISettings({}),{provider:'deepseek',apiKey:'test-secret'}));
  let called=0;
  const value=await chatJSON('只返回 JSON',{materialId:'real-id'},config,{fetchImpl:async(url,opts)=>{
    called++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(opts.headers.Authorization,'Bearer test-secret');
    const b=JSON.parse(opts.body);assert.equal(b.model,'deepseek-flash');assert.equal(b.response_format.type,'json_object');assert.equal(JSON.parse(b.messages[1].content).materialId,'real-id');
    assert.equal(opts.redirect,'error');return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})};
  }});assert.deepEqual(value,{ok:true});assert.equal(called,1);
});

test('Gemini 原生请求、分段返回及排除思考文本',async()=>{
  const config=textConfig(updateAISettings(normalizeAISettings({}),{provider:'gemini',apiKey:'gemini-secret'}));
  const value=await chatJSON('系统要求',{materialId:'real-id'},config,{fetchImpl:async(url,opts)=>{
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    assert.equal(url.includes('secret'),false);assert.equal(opts.headers['x-goog-api-key'],'gemini-secret');assert.equal(opts.headers.Authorization,undefined);
    const b=JSON.parse(opts.body);assert.equal(b.systemInstruction.parts[0].text,'系统要求');assert.equal(JSON.parse(b.contents[0].parts[0].text).materialId,'real-id');assert.equal(b.generationConfig.responseMimeType,'application/json');
    return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'不要保存的思考内容'},{text:'{"ok":'},{text:'true}'}]}}]})};
  }});assert.deepEqual(value,{ok:true});
});

test('服务失败、截断、安全拦截和错误 JSON 不产生分析也不暴露原响应',async()=>{
  const config=textConfig(updateAISettings(normalizeAISettings({}),{provider:'gemini',apiKey:'private-key'}));
  for(const status of [401,403,404,429,500])await assert.rejects(chatJSON('JSON',{},config,{fetchImpl:async()=>({ok:false,status,json:async()=>({error:'private-key'})})}),e=>e.message.includes(String(status))&&!e.message.includes('private-key'));
  for(const result of [{promptFeedback:{blockReason:'SAFETY'}},{candidates:[{finishReason:'MAX_TOKENS'}]},{candidates:[{finishReason:'STOP',content:{parts:[{text:'invalid'}]}}]}])await assert.rejects(chatJSON('JSON',{},config,{fetchImpl:async()=>({ok:true,json:async()=>result})}));
  await assert.rejects(chatJSON('JSON',{},config,{fetchImpl:async()=>{throw Error('private-key');}}),e=>!e.message.includes('private-key'));
  const missing={...config,apiKey:''};await assert.rejects(chatJSON('JSON',{},missing,{fetchImpl:async()=>{throw Error('不应调用');}}),/接口密钥/);
});

test('503 有限重试后成功，同一服务、文案和密钥保持一致',async()=>{
  const config=textConfig(updateAISettings(normalizeAISettings({}),{provider:'gemini',apiKey:'test-secret'}));
  const calls=[],delays=[],progress=[];
  const result=await chatJSON('JSON',{materialId:'sample',segments:[{id:'s0',text:'测试文案'}]},config,{
    fetchImpl:async(url,options)=>{calls.push({url,body:options.body,key:options.headers['x-goog-api-key']});if(calls.length<3)return {ok:false,status:503};return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"ok":true}'}]}}]})};},
    waitImpl:async ms=>delays.push(ms),onProgress:message=>progress.push(message)
  });
  assert.equal(result.ok,true);assert.equal(calls.length,3);assert.deepEqual(calls[0],calls[2]);
  assert.ok(delays[0]>=1000&&delays[0]<1250);assert.ok(delays[1]>=2000&&delays[1]<2250);assert.equal(progress.length,2);
});

test('重试有上限；余额、认证、额度与超时错误不重复发送',async()=>{
  const config=textConfig(updateAISettings(normalizeAISettings({}),{provider:'gemini',apiKey:'test-secret'}));
  let attempts=0;
  await assert.rejects(chatJSON('JSON',{},config,{fetchImpl:async()=>{attempts++;return {ok:false,status:503};},waitImpl:async()=>{}}),e=>e.details.httpStatus===503&&e.details.attempts===3&&/重试 2 次/.test(e.message));
  assert.equal(attempts,3);
  for(const status of [400,401,402,403,404,429]){
    attempts=0;await assert.rejects(chatJSON('JSON',{},config,{fetchImpl:async()=>{attempts++;return {ok:false,status};},waitImpl:async()=>{throw Error('不应等待');}}));assert.equal(attempts,1);
  }
  attempts=0;await assert.rejects(chatJSON('JSON',{},config,{fetchImpl:async()=>{attempts++;throw Object.assign(Error('private-key'),{name:'TimeoutError'});}}),e=>e.details.kind==='timeout'&&/等待超时/.test(e.message)&&!e.message.includes('private-key'));assert.equal(attempts,1);
});


test('拆解 Schema 限定真实素材与段落编号，并随请求传给 Gemini',async()=>{
  const record={id:'real-material',segments:[{id:'s0',text:'第一句'},{id:'s2',text:'第二句'}]},schema=analysisSchema(record);
  assert.deepEqual(schema.properties.materialId.enum,['real-material']);assert.deepEqual(schema.properties.outline.items.properties.segmentId.enum,['s0','s2']);assert.equal(schema.properties.outline.maxItems,12);
  const config=textConfig(updateAISettings(normalizeAISettings({}),{provider:'gemini',apiKey:'test-key'}));
  await chatJSON('JSON',record,config,{responseSchema:schema,fetchImpl:async(url,opts)=>{assert.deepEqual(JSON.parse(opts.body).generationConfig.responseSchema,schema);return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"ok":true}'}]}}]})};}});
});


test('连接或响应中断可重连，错误 JSON 不作为网络故障重试',async()=>{
  const config=textConfig(updateAISettings(normalizeAISettings({}),{provider:'gemini',apiKey:'test-key'}));let attempts=0;const progress=[];
  const result=await chatJSON('JSON',{},config,{waitImpl:async()=>{},onProgress:m=>progress.push(m),fetchImpl:async()=>{attempts++;if(attempts===1)throw Object.assign(Error('do not expose'),{cause:{code:'ECONNRESET'}});if(attempts===2)return {ok:true,json:async()=>{throw Object.assign(Error('do not expose'),{cause:{code:'UND_ERR_SOCKET'}});}};return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"ok":true}'}]}}]})};}});
  assert.equal(result.ok,true);assert.equal(attempts,3);assert.equal(progress.length,2);
  attempts=0;await assert.rejects(chatJSON('JSON',{},config,{fetchImpl:async()=>{attempts++;return {ok:true,json:async()=>{throw new SyntaxError('bad JSON');}};}}),/响应格式/);assert.equal(attempts,1);
});

test('GPT 官方预设与兼容接口隔离，OpenAI JSON 请求和认证正确',async()=>{
  const official=normalizeAISettings({});
  assert.equal(textConfig(official,'openai').chatModel,'gpt-6-luna');
  assert.equal(textConfig(normalizeAISettings({baseUrl:'https://custom.example/v1'}),'openai').chatModel,'');
  assert.equal(textConfig(normalizeAISettings({chatModel:'my-existing-model'}),'openai').chatModel,'my-existing-model');
  const config=textConfig(updateAISettings(official,{provider:'openai',apiKey:'test-only-key'}));
  const result=await chatJSON('只返回 JSON',{test:'connection'},config,{fetchImpl:async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/chat/completions');
    assert.equal(options.headers.Authorization,'Bearer test-only-key');
    const body=JSON.parse(options.body);assert.equal(body.model,'gpt-6-luna');assert.equal(body.response_format.type,'json_object');
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})};
  }});
  assert.deepEqual(result,{ok:true});
});
