import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {promises as fs} from 'node:fs';
import {transcriptReference} from '../public/transcript-review.mjs';
import {AI_PROVIDERS} from '../public/ai-providers.mjs';
import {normalizeAISettings,updateAISettings,publicAISettings} from '../ai.mjs';

test('默认全文、折叠校对、双向编辑、失败重试、无接口的 ChatGPT 拆解和配置后手动分析',async()=>{
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const script=(await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^(?:import[^\n]+\n)+/,'');
  const dom=new JSDOM(html,{url:'https://workbench.test/?settings=ai&v=20261014-ai2',runScripts:'outside-only'}),window=dom.window;
  // JSDOM does not implement native dialog open/close behavior.
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const record={id:'test-record',title:'测试素材',duration:6,width:320,height:180,tags:[],originalName:'test.mp4',transcriptSource:'audio-local',segments:[{id:'s0',start:0,end:2,text:'第一句'},{id:'s1',start:2,end:4,text:'第二句'}],draft:{},creationVersions:[],job:{state:'idle'},revision:1};
  let settings=normalizeAISettings({});
  const calls=[];let poll;const analysis={topic:'测试选题',audience:'测试观众',conflict:'测试矛盾',viewpoint:'测试观点',template:'测试结构',outline:[{start:0,quote:'修正第一句',role:'开头',explanation:'测试分析'}],techniques:['测试方法'],claims:[],ideas:['测试方向']};
  window.scrollTo=()=>{};window.confirm=()=>true;window.transcriptReference=transcriptReference;window.AI_PROVIDERS=AI_PROVIDERS;
  window.setInterval=fn=>{if(!poll)poll=fn;return 1;};
  window.fetch=async(url,options={})=>{
    calls.push({url,body:options.body?JSON.parse(options.body):null});let result;
    if(url==='/api/bootstrap')result={token:'test-token',records:[record],imports:[{id:'failed',state:'error',message:'测试失败',sourceUrl:'https://youtu.be/test',originalText:'分享文字 https://youtu.be/test',extract:true}],localSpeech:true,settings:{}};
    else if(url.endsWith('/retry')||url==='/api/imports'&&options.method==='POST')result={id:'new-job',state:'running',goAnalyze:true};
    else if(url==='/api/imports')result=[{id:'new-job',state:'done',recordId:'test-record',sourceUrl:'https://youtu.be/test',message:'测试完成'}];
    else if(url.endsWith('/transcript')){record.segments=JSON.parse(options.body).segments;result=record;}
    else if(url.endsWith('/bridge?kind=analysis'))result={prompt:'测试拆解请求：修正第一句',revision:record.revision};
    else if(url.endsWith('/import-analysis')){record.analysis=analysis;record.analysisSource='chatgpt';result=record;}
    else if(url==='/api/settings'){if(options.method==='POST')settings=updateAISettings(settings,JSON.parse(options.body));result=publicAISettings(settings);}
    else if(url==='/api/settings/test')result={ok:true,provider:settings.provider,model:settings.textProviders[settings.provider].chatModel};
    else if(url.endsWith('/analyze')){record.job={state:'running',message:'测试分析中'};result=record;}
    else if(url==='/api/records/test-record')result=record;
    else result=[];
    return {ok:true,json:async()=>result};
  };
  await window.eval('(async()=>{'+script+'})()');
  assert.equal(window.document.querySelector('#settings-dialog').open,true);
  assert.deepEqual([...window.document.querySelectorAll('select[name=provider] option')].map(o=>o.value),['chatgpt','openai','deepseek','gemini']);
  window.document.querySelector('#settings-dialog').close();
  const full=window.document.querySelector('#full-transcript');assert.equal(full.value,'第一句\n第二句');assert.equal(window.document.querySelector('.time-review').open,false);
  full.value='修正第一句\n第二句';full.dispatchEvent(new window.Event('input'));assert.equal(window.document.querySelector('[data-segment="0"]').value,'修正第一句');
  const segment=window.document.querySelector('[data-segment="1"]');segment.value='修正第二句';segment.dispatchEvent(new window.Event('input'));assert.match(full.value,/修正第二句/);
  await window.document.querySelector('#save-transcript').onclick();assert.equal(calls.at(-1).body.segments[1].start,2);
  window.document.querySelector('[data-retry-import]').click();await new Promise(r=>setTimeout(r,10));assert.equal(calls.at(-1).url,'/api/imports/failed/retry');
  const input=window.document.querySelector('#douyin-link');input.value='https://www.bilibili.com/video/BVtest';await window.document.querySelector('#link-form').onsubmit({preventDefault(){}});assert.equal(input.value,'https://www.bilibili.com/video/BVtest');assert.equal(calls.at(-1).body.goAnalyze,true);
  poll();await new Promise(r=>setTimeout(r,20));assert.equal(window.document.querySelector('[data-tab="analysis"]').getAttribute('aria-selected'),'true');
  const doc=window.document;
  assert.match(doc.querySelector('.analysis-help').textContent,/尚未配置/);
  assert.equal(doc.querySelector('#analyze').textContent,'AI 拆解');
  await doc.querySelector('#analyze').onclick();
  assert.equal(doc.querySelector('#analysis-dialog').open,true);
  assert.deepEqual([...doc.querySelectorAll('[name=analysis-provider]')].map(i=>i.value),['chatgpt','deepseek','gemini','openai']);
  assert.equal(calls.some(c=>c.url.endsWith('/analyze')),false,'打开选择窗口不调用 AI');
  const pick=id=>{const i=doc.querySelector(`[name="analysis-provider"][value="${id}"]`);i.checked=true;i.dispatchEvent(new window.Event('change'));};
  pick('gemini');assert.match(doc.querySelector('#analysis-start').textContent,/配置 Gemini/);
  await doc.querySelector('#analysis-start').onclick();assert.equal(doc.querySelector('#settings-form').elements.provider.value,'gemini');assert.equal(calls.some(c=>c.url.endsWith('/analyze')),false);
  doc.querySelector('#settings-dialog').close();
  doc.querySelector('#copy-analysis').click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(calls.at(-1).url,'/api/records/test-record/bridge?kind=analysis');
  assert.equal(doc.querySelector('#text-dialog').open,true);
  assert.match(doc.querySelector('#text-dialog-input').value,/修正第一句/);
  assert.equal(doc.querySelector('#settings-dialog').open,false);
  assert.equal(calls.some(c=>c.url.endsWith('/analyze')),false);
  doc.querySelector('#text-dialog').close();
  doc.querySelector('#import-analysis').click();
  doc.querySelector('#text-dialog-input').value=JSON.stringify(analysis);
  await doc.querySelector('#text-dialog-submit').onclick();
  assert.equal(calls.at(-1).body.revision,1);
  assert.match(doc.querySelector('#tab-content').textContent,/测试观点/);
  assert.match(doc.querySelector('#tab-content').textContent,/ChatGPT 导入/);
  doc.querySelector('#configure-analysis').click();
  assert.equal(doc.querySelector('#settings-dialog').open,true);
  const form=doc.querySelector('#settings-form');
  form.elements.apiKey.value='test-key';form.elements.chatModel.value='test-model';
  const changeProvider=id=>{form.elements.provider.value=id;form.elements.provider.dispatchEvent(new window.Event('change'));};
  changeProvider('gemini');assert.equal(form.elements.apiKey.value,'');assert.equal(form.elements.baseUrl.readOnly,true);assert.equal(form.elements.chatModel.value,AI_PROVIDERS.gemini.chatModel);assert.equal(doc.querySelector('#cloud-speech-setting').hidden,true);
  form.elements.apiKey.value='gemini-draft-key';changeProvider('deepseek');assert.equal(form.elements.apiKey.value,'');assert.equal(form.elements.chatModel.value,AI_PROVIDERS.deepseek.chatModel);
  changeProvider('gemini');assert.equal(form.elements.apiKey.value,'gemini-draft-key');
  changeProvider('openai');assert.equal(form.elements.apiKey.value,'test-key');assert.equal(form.elements.chatModel.value,'test-model');assert.equal(form.elements.baseUrl.readOnly,false);
  const beforeTest=calls.length;await doc.querySelector('#test-ai').onclick();assert.equal(calls.length,beforeTest);assert.match(doc.querySelector('#settings-error').textContent,/请先保存/);
  await form.onsubmit({preventDefault(){},target:form});
  assert.equal(doc.querySelector('#settings-dialog').open,false);
  assert.equal(doc.querySelector('#analyze').textContent,'重新 AI 拆解');
  assert.equal(doc.querySelector('.analysis-help'),null);
  assert.equal(calls.some(c=>c.url.endsWith('/analyze')),false,'保存设置不能自动发送文案');
  await doc.querySelector('#analyze').onclick();
  assert.equal(doc.querySelector('#analysis-dialog').open,true);assert.equal(calls.some(c=>c.url.endsWith('/analyze')),false);
  assert.match(doc.querySelector('#analysis-start').textContent,/使用 GPT \/ OpenAI/);
  await doc.querySelector('#analysis-start').onclick();
  assert.equal(calls.at(-1).body.provider,'openai');
  assert.equal(calls.at(-1).url,'/api/records/test-record/analyze');
  assert.equal(doc.querySelector('#analyze').disabled,true);
  record.job={state:'error',message:'DeepSeek 返回错误（402）：接口余额不足。'};
  doc.querySelector('#settings-open').click();changeProvider('gemini');form.elements.apiKey.value='gemini-test-key';
  const analyzedBefore=calls.filter(c=>c.url.endsWith('/analyze')).length;
  await form.onsubmit({preventDefault(){},target:form});assert.equal(calls.at(-1).body.provider,'gemini');assert.match(doc.querySelector('#tab-content').textContent,/默认文字服务：Gemini/);
  assert.equal(calls.filter(c=>c.url.endsWith('/analyze')).length,analyzedBefore);
  doc.querySelector('#settings-open').click();assert.equal(form.elements.apiKey.value,'');assert.match(form.elements.apiKey.placeholder,/已保存/);
  await doc.querySelector('#test-ai').onclick();assert.equal(calls.at(-1).url,'/api/settings/test');assert.equal(calls.at(-1).body.materialId,undefined);assert.match(doc.querySelector('#ai-test-status').textContent,/连接成功：Gemini/);
  changeProvider('openai');assert.equal(form.elements.apiKey.value,'');assert.equal(form.elements.chatModel.value,'test-model');assert.match(form.elements.apiKey.placeholder,/已保存/);
  doc.querySelector('#settings-dialog').close();
  await doc.querySelector('#analyze').onclick();assert.equal(doc.querySelector('#analysis-dialog').open,true);assert.equal(doc.querySelector('#analysis-previous-error').hidden,false);assert.match(doc.querySelector('#analysis-previous-error').textContent,/余额不足/);
  pick('openai');assert.match(doc.querySelector('#analysis-provider-note').textContent,/不会改变默认服务/);
  const requestsBeforeStart=calls.filter(c=>c.url.endsWith('/analyze')).length;assert.equal(requestsBeforeStart,analyzedBefore);
  await doc.querySelector('#analysis-start').onclick();assert.equal(calls.at(-1).body.provider,'openai');assert.equal(settings.provider,'gemini');
  assert.equal(doc.querySelector('#analysis-dialog').open,false);
  dom.window.close();
});

test('GPT 直达设置只打开指定服务，预填官方模型且保留兼容配置，不自动保存或调用',async()=>{
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const script=(await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^(?:import[^\n]+\n)+/,'');
  for(const openai of [{baseUrl:'https://api.openai.com/v1',chatModel:''},{baseUrl:'https://custom.example/v1',chatModel:''},{baseUrl:'https://api.openai.com/v1',chatModel:'existing-model'}]){
    const dom=new JSDOM(html,{url:'https://workbench.test/?settings=ai&provider=openai',runScripts:'outside-only'}),w=dom.window,calls=[];
    w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
    w.transcriptReference=transcriptReference;w.AI_PROVIDERS=AI_PROVIDERS;w.setInterval=()=>1;
    const safe=publicAISettings(normalizeAISettings({provider:'gemini',textProviders:{openai}}));
    w.fetch=async(url,opts={})=>{calls.push({url,method:opts.method});return {ok:true,json:async()=>({token:'test-token',records:[],imports:[],settings:safe})};};
    await w.eval('(async()=>{'+script+'})()');
    const f=w.document.querySelector('#settings-form');assert.equal(f.closest('dialog').open,true);assert.equal(f.elements.provider.value,'openai');
    assert.equal(f.elements.chatModel.value,openai.chatModel||(openai.baseUrl===AI_PROVIDERS.openai.baseUrl?AI_PROVIDERS.openai.chatModel:''));
    assert.equal(f.elements.baseUrl.value,openai.baseUrl);assert.equal(f.elements.apiKey.type,'password');assert.equal(f.elements.apiKey.value,'');
    assert.equal(safe.provider,'gemini');assert.deepEqual(calls,[{url:'/api/bootstrap',method:undefined}]);
    dom.window.close();
  }
});

test('ChatGPT 登录需要主动同意，完成授权才可拆解，不自动发素材或要求 API 密钥',async()=>{
  const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');const script=(await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^(?:import[^\n]+\n)+/,'');
  const dom=new JSDOM(html,{url:'https://workbench.test/?settings=ai&provider=chatgpt',runScripts:'outside-only'}),w=dom.window;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.transcriptReference=transcriptReference;w.AI_PROVIDERS=AI_PROVIDERS;w.scrollTo=()=>{};let poll;
  w.setInterval=fn=>{poll=fn;return 1;};const calls=[];let account={connected:false,accounts:[],models:[],model:'',credentialPath:'/test/local/chatgpt/connections.json',attempt:{state:'idle'}};let defaultProvider='gemini';
  const r={id:'real-fixture',title:'测试素材',duration:6,width:320,height:180,tags:[],originalName:'test.mp4',transcriptSource:'manual',segments:[{id:'s0',start:0,end:4,text:'测试真实文案'}],draft:{},creationVersions:[],job:{state:'idle'}};
  const safe=()=>{const s=publicAISettings(normalizeAISettings({provider:defaultProvider}));s.chatgpt=account;s.profiles.chatgpt={baseUrl:AI_PROVIDERS.chatgpt.baseUrl,chatModel:account.model,hasKey:false,hasAuth:account.connected,ready:!!(account.connected&&account.model)};return s;};
  let opened=0;w.open=()=>{opened++;return {opener:null,location:{replace:url=>assert.match(url,/^https:\/\/auth.openai.com\/api\/accounts\/authorize/)},close(){}};};
  w.fetch=async(url,opts={})=>{const body=opts.body?JSON.parse(opts.body):null;calls.push({url,body});let value;
    if(url==='/api/bootstrap')value={token:'test-token',records:[r],imports:[],localSpeech:true,settings:safe()};
    else if(url==='/api/chatgpt/start'){assert.equal(body.consent,true);account.attempt={state:'pending',message:'等待授权'};value={url:'https://auth.openai.com/api/accounts/authorize?state=test'};}
    else if(url==='/api/chatgpt/status')value=account;
    else if(url==='/api/settings'){if(opts.method==='POST')defaultProvider=body.provider;value=safe();}
    else if(url.endsWith('/analyze')){r.job={state:'running',message:'正在测试分析'};value=r;}
    else value=[];return {ok:true,json:async()=>value};
  };
  await w.eval('(async()=>{'+script+'})()');const doc=w.document;
  assert.equal(doc.querySelector('#chatgpt-connection').hidden,false);assert.equal(doc.querySelector('#api-credentials').hidden,true);assert.equal(doc.querySelector('#chatgpt-connect').disabled,true);assert.equal(doc.querySelector('#settings-submit').disabled,true);
  await doc.querySelector('#chatgpt-connect').onclick();assert.equal(opened,0);assert.equal(calls.some(c=>c.url==='/api/chatgpt/start'),false);
  doc.querySelector('#chatgpt-consent').checked=true;doc.querySelector('#chatgpt-consent').dispatchEvent(new w.Event('change'));await doc.querySelector('#chatgpt-connect').onclick();assert.equal(opened,1);assert.equal(doc.querySelector('#chatgpt-connect').disabled,true);
  assert.equal(calls.some(c=>c.url.endsWith('/analyze')),false);
  account={...account,connected:true,planAuthorized:true,activeId:'test-account',email:'test@example.test',model:'available-model',models:[{id:'available-model',label:'可用模型'}],accounts:[{id:'test-account',label:'账户 1',email:'test@example.test',connected:true}],attempt:{state:'done',message:'授权完成'}};
  poll();await new Promise(resolve=>setTimeout(resolve,15));assert.equal(doc.querySelector('#settings-submit').disabled,false);assert.equal(doc.querySelector('#chatgpt-model').value,'available-model');assert.equal(calls.some(c=>c.url.endsWith('/analyze')),false);assert.equal(defaultProvider,'gemini');
  doc.querySelector('#settings-dialog').close();doc.querySelector('[data-tab="analysis"]').click();await doc.querySelector('#analyze').onclick();assert.match(doc.querySelector('#analysis-start').textContent,/使用 GPT \/ ChatGPT 套餐/);
  await doc.querySelector('#analysis-start').onclick();assert.equal(calls.at(-1).body.provider,'chatgpt');assert.equal(defaultProvider,'gemini');assert.equal(calls.at(-1).url,'/api/records/real-fixture/analyze');
  r.job={state:'idle'};doc.querySelector('#settings-open').click();const provider=doc.querySelector('#settings-form').elements.provider;provider.value='chatgpt';provider.dispatchEvent(new w.Event('change'));
  doc.querySelector('#chatgpt-consent').checked=true;doc.querySelector('#chatgpt-consent').dispatchEvent(new w.Event('change'));
  w.open=()=>{throw new Error('popup blocked');};const startedBefore=calls.filter(c=>c.url==='/api/chatgpt/start').length;await doc.querySelector('#chatgpt-connect').onclick();assert.equal(calls.filter(c=>c.url==='/api/chatgpt/start').length,startedBefore+1);assert.equal(doc.querySelector('#chatgpt-auth-url').hidden,false);assert.match(doc.querySelector('#chatgpt-auth-url').href,/^https:\/\/auth.openai.com\/api\/accounts\/authorize/);
  dom.window.close();
});
