import {AI_PROVIDERS} from './public/ai-providers.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function normalBase(value){
  let u;try{u=new URL(value);}catch{throw fail('接口地址格式不正确。');}
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)))throw fail('接口地址需要使用 HTTPS。');
  if(u.username||u.password||u.search||u.hash)throw fail('接口地址不能包含密钥或查询参数。');
  return u.toString().replace(/\/$/,'');
}
export function normalizeAISettings(input){
  const profiles={};
  for(const [id,defaults] of Object.entries(AI_PROVIDERS)){
    const saved=input.textProviders?.[id]||{};
    const legacy=id==='openai'?input:{};
    const baseUrl=id==='openai'?(saved.baseUrl??legacy.baseUrl??defaults.baseUrl):defaults.baseUrl;
    profiles[id]={baseUrl,
      chatModel:saved.chatModel??legacy.chatModel??(id==='openai'&&baseUrl.replace(/\/$/,'')!==defaults.baseUrl?'':defaults.chatModel),apiKey:saved.apiKey??legacy.apiKey??''};
  }
  const provider=Object.hasOwn(AI_PROVIDERS,input.provider)?input.provider:'openai';
  // Legacy fields remain the separate OpenAI-compatible audio configuration.
  return {...input,provider,textProviders:profiles,...profiles.openai};
}
export function textConfig(settings,provider=settings.provider){if(!Object.hasOwn(AI_PROVIDERS,provider))throw fail('请选择支持的 AI 服务。');return {provider,...settings.textProviders[provider]};}
export function analysisSchema(record){
  const text={type:'STRING'},list={type:'ARRAY',items:text,maxItems:20};
  return {type:'OBJECT',properties:{
    materialId:{type:'STRING',enum:[record.id]},topic:text,audience:text,conflict:text,viewpoint:text,template:text,
    outline:{type:'ARRAY',minItems:1,maxItems:12,items:{type:'OBJECT',properties:{segmentId:{type:'STRING',enum:record.segments.map(s=>s.id)},role:text,explanation:text},required:['segmentId','role','explanation']}},
    techniques:list,claims:list,ideas:list
  },required:['materialId','topic','audience','conflict','viewpoint','template','outline','techniques','claims','ideas']};
}
export function updateAISettings(settings,input){
  const provider=input.provider??settings.provider;
  if(!Object.hasOwn(AI_PROVIDERS,provider))throw fail('请选择支持的 AI 服务。');
  const profiles=structuredClone(settings.textProviders),old=profiles[provider];
  let chatModel=String(input.chatModel??old.chatModel).trim().slice(0,150);
  if(provider==='gemini')chatModel=chatModel.replace(/^models\//,'');
  if(provider==='gemini'&&chatModel&&!/^[a-zA-Z0-9._-]+$/.test(chatModel))throw fail('Gemini 模型名称格式不正确。');
  profiles[provider]={baseUrl:provider==='openai'?normalBase(input.baseUrl??old.baseUrl):AI_PROVIDERS[provider].baseUrl,
    chatModel,apiKey:provider==='chatgpt'||input.clearKey?'':String(input.apiKey||old.apiKey).trim().slice(0,2000)};
  return normalizeAISettings({...settings,provider,textProviders:profiles});
}
export function publicAISettings(settings){
  const profiles=Object.fromEntries(Object.entries(settings.textProviders).map(([id,p])=>[id,{baseUrl:p.baseUrl,chatModel:p.chatModel,hasKey:!!p.apiKey}]));
  const current=profiles[settings.provider];
  return {provider:settings.provider,providerLabel:AI_PROVIDERS[settings.provider].label,profiles,...current,
    transcriptionModel:settings.transcriptionModel,transcriptionReady:!!settings.apiKey,
    ready:!!(current.hasKey&&current.chatModel),parserEnabled:!!settings.parserEnabled,hasParserKey:!!(settings.parserKey&&settings.parserSecret)};
}
function statusError(status,label,attempts=1){
  const reason=status===401?'密钥无效，请检查该服务的接口密钥':status===403?'访问被拒绝，请检查权限或服务支持地区':status===402?'接口余额不足':status===404?'找不到模型或接口，请检查模型名称':status===429?'额度不足或请求过于频繁，请检查额度或稍后重试':status>=500?'服务暂时不可用，请稍后重试':'请求被拒绝，请检查模型和接口设置';
  const error=fail(`${label} 返回错误（${status}）：${reason}。${attempts>1?`已自动重试 ${attempts-1} 次，仍未完成；可更换模型后重试。`:''}`,502);error.details={httpStatus:status,attempts};return error;
}
export async function chatJSON(system,user,config,{fetchImpl=fetch,waitImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms)),onProgress=()=>{},responseSchema}={}){
  if(config.provider==='chatgpt'){
    if(typeof config.complete!=='function')throw fail('请先登录 ChatGPT 并完成套餐授权。',503);
    return config.complete(system,user,{onProgress});
  }
  const {provider,apiKey,chatModel}=config,label=AI_PROVIDERS[provider]?.label;
  if(!label)throw fail('AI 服务配置不受支持。');
  if(!apiKey)throw fail(`请先配置 ${label} 的接口密钥。`,503);
  if(!chatModel)throw fail('请在 AI 设置中填写文字模型名称。',503);
  const native=provider==='gemini',base=provider==='openai'?normalBase(config.baseUrl):AI_PROVIDERS[provider].baseUrl;
  const url=native?`${base}/models/${encodeURIComponent(chatModel.replace(/^models\//,''))}:generateContent`:`${base}/chat/completions`;
  const payload=native?{systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:JSON.stringify(user)}]}],generationConfig:{responseMimeType:'application/json',...(responseSchema?{responseSchema}:{})}}:
    {model:chatModel,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(user)}],response_format:{type:'json_object'},stream:false};
  let response,result;
  const deadline=Date.now()+180000;
  for(let attempt=1;attempt<=3;attempt++){
    try{response=await fetchImpl(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(native?{'x-goog-api-key':apiKey}:{Authorization:'Bearer '+apiKey})},body:JSON.stringify(payload),signal:AbortSignal.timeout(Math.max(1,deadline-Date.now()))});if(response.ok){result=await response.json();break;}}
    catch(e){
      if(e.name==='SyntaxError')throw fail(`${label} 返回的响应格式不正确，可以重试。`,502);
      const code=e.cause?.code||e.code,known=['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','EPIPE'];
      const networkCode=known.includes(code)?code:undefined;
      const timedOut=e.name==='TimeoutError'||e.name==='AbortError'||networkCode==='UND_ERR_HEADERS_TIMEOUT';
      const retryable=['UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','EPIPE'].includes(networkCode);
      const delay=1000*2**(attempt-1)+Math.floor(Math.random()*250);
      if(!timedOut&&retryable&&attempt<3&&Date.now()+delay<deadline){onProgress(`${label} 连接中断，正在重新连接（${attempt}/2）…`);await waitImpl(delay);continue;}
      const error=fail(timedOut?`${label} 请求等待超时，原文已保留，请重试或选择其他模型。`:`连接 ${label} 失败，请检查本机网络或稍后重试。${attempt>1?`已重新连接 ${attempt-1} 次。`:''}`,502);error.details={kind:timedOut?'timeout':'connection',attempts:attempt,...(networkCode?{networkCode}:{})};throw error;
    }

    const transient=[502,503,504].includes(response.status),delay=1000*2**(attempt-1)+Math.floor(Math.random()*250);
    if(!transient||attempt===3||Date.now()+delay>=deadline)throw statusError(response.status,label,attempt);
    await response.body?.cancel();
    onProgress(`${label} 暂时繁忙，正在等待重试（${attempt}/2）…`);
    await waitImpl(delay);
  }
  let text;
  if(native){
    const candidate=result.candidates?.[0];
    if(result.promptFeedback?.blockReason||candidate?.finishReason==='SAFETY')throw fail('Gemini 未通过内容检查，未保存拆解，请核对文案。',502);
    if(candidate?.finishReason==='MAX_TOKENS')throw fail('Gemini 返回内容被截断，未保存拆解，请缩短文案后重试。',502);
    if(candidate?.finishReason&&candidate.finishReason!=='STOP')throw fail('Gemini 未正常完成生成，原文已保留，请重试。',502);
    text=candidate?.content?.parts?.filter(p=>!p.thought&&typeof p.text==='string').map(p=>p.text).join('');
  }else{
    const choice=result.choices?.[0];
    if(choice?.finish_reason==='length')throw fail(`${label} 返回内容被截断，未保存拆解，请缩短文案后重试。`,502);
    if(choice?.finish_reason&&choice.finish_reason!=='stop')throw fail(`${label} 未正常完成生成，原文已保留，请重试。`,502);
    text=choice?.message?.content;
  }
  if(typeof text!=='string'||!text.trim())throw fail(`${label} 没有返回可用内容，原文已保留。`,502);
  try{const value=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}
  catch{throw fail(`${label} 返回的 JSON 格式不正确，原文已保留，可以重试。`,502);}
}
