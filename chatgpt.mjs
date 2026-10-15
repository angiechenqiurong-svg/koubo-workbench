import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID,randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify} from 'jose';

const ISSUER='https://auth.openai.com',RESOURCE='https://api.openai.com/v1';
const TOKEN=ISSUER+'/api/accounts/oauth/token',AUTHORIZE=ISSUER+'/api/accounts/authorize';
const JWKS=createRemoteJWKSet(new URL(ISSUER+'/.well-known/jwks.json'));
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const random=()=>randomBytes(32).toString('base64url');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const scopes=value=>typeof value==='string'?[...new Set(value.split(/\s+/).filter(Boolean))]:[];
const planAllowed=p=>p?.scopes?.includes('chatgpt.tokens.use.direct')&&p.scopes.includes('resource.invoke');

export async function verifyOpenAIIdentity(token,{clientId,nonce,subject},jwks=JWKS){
  const {payload}=await jwtVerify(token,jwks,{issuer:ISSUER,audience:clientId,algorithms:['RS256'],requiredClaims:['sub','exp','iat'],clockTolerance:5});
  if(typeof payload.sub!=='string'||!payload.sub||nonce!==undefined&&!same(payload.nonce,nonce)||subject!==undefined&&payload.sub!==subject)throw fail('ChatGPT 身份校验失败，请重新登录。',401);
  return payload;
}

function serviceError(status,code=''){
  const messages={subscription_sharing_user_not_eligible:'当前账户或工作区未开放套餐授权，请查看账户的套餐使用权限。',subscription_sharing_usage_limit_exceeded:'本应用的 ChatGPT 可用额度已达到限制，请查看额度设置或等待恢复。',subscription_sharing_usage_unavailable:'ChatGPT 套餐额度暂时不可用，请稍后重试。',subscription_sharing_user_unavailable:'ChatGPT 账户信息暂时不可用，请稍后重试。',subscription_sharing_unsupported_capability:'ChatGPT 套餐不支持本次请求的模型或参数。',subscription_sharing_route_not_supported:'ChatGPT 套餐不支持当前接口，请检查接入配置。',chatpass_v2_scope_not_authorized:'当前授权未允许使用 ChatGPT 套餐，请检查授权设置。',chatpass_v2_invalid_authorization_context:'ChatGPT 授权上下文未通过校验，请检查账户与授权。',invalid_grant:'ChatGPT 授权已失效，请重新登录。',invalid_client:'ChatGPT 登录客户端配置未被接受，请检查接入配置。'};
  const message=messages[code]||(status===401?'ChatGPT 授权已失效，请重新登录。':status===403?'ChatGPT 未允许这次请求，请检查账户及套餐授权。':status===429?'ChatGPT 额度不足或请求过于频繁，请稍后重试。':status>=500?'ChatGPT 服务暂时不可用，请稍后重试。':'ChatGPT 请求未成功，请重新登录或稍后重试。');
  const error=fail(message,502);error.authExpired=['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused'].includes(code);error.details={httpStatus:status,...(Object.hasOwn(messages,code)?{code}:{})};return error;
}

export async function readResponsesJSON(response){
  if(!response.body)throw fail('ChatGPT 未返回生成内容。',502);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',text='',total=0,completed=false,terminalText='';
  const event=raw=>{
    const data=raw.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data||data==='[DONE]')return;
    let value;try{value=JSON.parse(data);}catch{throw fail('ChatGPT 返回的事件格式异常，结果未保存。',502);}
    if(value.type==='response.output_text.delta'&&typeof value.delta==='string')text+=value.delta;
    if(value.type==='error'||value.type==='response.failed')throw serviceError(502,value.error?.code||value.response?.error?.code||value.code);
    if(value.type==='response.incomplete')throw fail('ChatGPT 生成未完成，结果未保存，请重试。',502);
    if(value.type==='response.completed'){
      if(value.response?.status&&value.response.status!=='completed')throw fail('ChatGPT 生成未正常完成。',502);
      completed=true;
      terminalText=(value.response?.output||[]).flatMap(o=>o.content||[]).filter(c=>c.type==='output_text'&&typeof c.text==='string').map(c=>c.text).join('');
    }
    if(text.length>500000)throw fail('ChatGPT 返回内容过长，结果未保存。',502);
  };
  try{
    while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>4*1024*1024)throw fail('ChatGPT 返回内容过长，结果未保存。',502);buffer=(buffer+decoder.decode(value,{stream:true})).replace(/\r\n/g,'\n');let index;while((index=buffer.indexOf('\n\n'))>=0){event(buffer.slice(0,index));buffer=buffer.slice(index+2);}}
    buffer+=decoder.decode();if(buffer.trim())event(buffer);
  }finally{await reader.cancel().catch(()=>{});}
  if(!completed)throw fail('ChatGPT 连接在生成完成前中断，结果未保存，请重试。',502);
  const raw=(terminalText||text).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{const result=JSON.parse(raw);if(!result||typeof result!=='object'||Array.isArray(result))throw Error();return result;}catch{throw fail('ChatGPT 返回的 JSON 格式不正确，结果未保存，请重试。',502);}
}

export class ChatGPTConnection {
  constructor(directory,{fetchImpl=fetch,verifyImpl=verifyOpenAIIdentity,now=()=>Date.now(),waitImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
    this.directory=directory;this.file=path.join(directory,'connections.json');this.hostFile=path.join(directory,'host.json');this.fetch=fetchImpl;this.verify=verifyImpl;this.now=now;this.wait=waitImpl;
    this.store={active:null,profiles:[]};this.pending=new Map();this.processing=new Set();this.refreshes=new Map();this.writes=Promise.resolve();this.attempt={state:'idle',message:''};this.authRevision=0;
  }
  async load(){
    for(const file of [this.directory,this.file,this.hostFile]){try{if((await fs.lstat(file)).isSymbolicLink())throw fail('ChatGPT 授权存储路径不能使用符号链接。',500);}catch(e){if(e.code!=='ENOENT')throw e;}}
    try{const s=JSON.parse(await fs.readFile(this.file,'utf8'));if(!Array.isArray(s.profiles))throw Error();this.store=s;await fs.chmod(this.file,0o600);}catch(e){if(e.code!=='ENOENT')throw fail('ChatGPT 本机授权文件无法读取，已有素材未受影响。',500);}
    try{this.hostId=JSON.parse(await fs.readFile(this.hostFile,'utf8')).id;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(this.hostId&&!/^urn:uuid:[a-f0-9-]{36}$/.test(this.hostId))throw fail('ChatGPT 设备标识格式异常。',500);
    return this;
  }
  async write(file,value){
    for(const target of [this.directory,file]){try{if((await fs.lstat(target)).isSymbolicLink())throw fail('ChatGPT 授权存储路径不能使用符号链接。',500);}catch(e){if(e.code!=='ENOENT')throw e;}}
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});await fs.chmod(this.directory,0o700);
    const tmp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});await fs.rename(tmp,file);await fs.chmod(file,0o600);}finally{await fs.rm(tmp,{force:true});}
  }
  save(){const next=this.writes.catch(()=>{}).then(()=>this.write(this.file,this.store));this.writes=next;return next;}
  profile(id=this.store.active){return this.store.profiles.find(p=>p.id===id);}
  isConnected(p=this.profile()){return !!(p?.access_token&&(p.expiresAt>this.now()||p.refresh_token)&&planAllowed(p));}
  publicState(){
    if(this.attempt.state==='pending'&&!this.processing.has(this.authRevision)&&![...this.pending.values()].some(t=>t.expiresAt>this.now()))this.attempt={state:'error',message:'ChatGPT 登录等待已过期，请重新发起登录。'};
    const p=this.profile();return {connected:this.isConnected(p),activeId:p?.id||null,email:p?.email||'',model:p?.model||'',models:p?.models||[],planAuthorized:!!planAllowed(p),credentialPath:this.file,
      accounts:this.store.profiles.map(x=>({id:x.id,email:x.email||'',label:x.label,connected:this.isConnected(x)})),attempt:{...this.attempt}};
  }
  async start({consent,profileId,newAccount=false},redirectUri){
    if(consent!==true)throw fail('请先同意将 ChatGPT 授权信息保存在本机。');
    const uri=new URL(redirectUri);if(uri.protocol!=='http:'||uri.hostname!=='127.0.0.1'||uri.pathname!=='/auth/callback'||uri.search||uri.hash)throw fail('ChatGPT 回调地址不正确。');
    if(!this.hostId){this.hostId='urn:uuid:'+randomUUID();await this.write(this.hostFile,{id:this.hostId});}
    const selected=newAccount?undefined:this.profile(profileId||this.store.active);if(profileId&&!selected&&!newAccount)throw fail('所选 ChatGPT 账户不存在。',404);
    const state=random(),nonce=random(),verifier=random(),binding=random();this.pending.clear();
    const t={state,nonce,verifier,binding,redirectUri,profileId:selected?.id,clientId:selected?.client_id||null,expiresAt:this.now()+600000,generation:++this.authRevision};this.pending.set(state,t);
    const u=new URL(AUTHORIZE);u.search=new URLSearchParams({client_id:t.clientId||'dynamic_agent_client',...(t.clientId?{}:{agent_name_hint:'口播工作台'}),ext_agent_host_id:this.hostId,response_type:'code',redirect_uri:redirectUri,
      scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource:RESOURCE,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),...(selected?.email?{login_hint:selected.email}:{}),...(selected&&!planAllowed(selected)?{prompt:'consent'}:{})}).toString();
    this.attempt={state:'pending',message:'等待你在 ChatGPT 页面完成登录和套餐授权。'};return {url:u.toString(),binding};
  }
  async request(url,options={}){
    try{return await this.fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000),...options});}catch{throw fail('连接 ChatGPT 失败，请检查网络后重试。',502);}
  }
  async tokens(params){
    const res=await this.request(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams(params)});
    let value;try{value=await res.json();}catch{throw fail('ChatGPT 授权服务返回格式异常。',502);}
    if(!res.ok)throw serviceError(res.status,value.error?.code||value.error);
    if(typeof value.access_token!=='string'||!value.access_token||typeof value.expires_in!=='number'||value.expires_in<=0||String(value.token_type).toLowerCase()!=='bearer')throw fail('ChatGPT 未返回有效授权，请重新登录。',502);
    return value;
  }
  async catalog(p){
    const res=await this.request(RESOURCE+'/models',{headers:{Authorization:'Bearer '+p.access_token}});if(!res.ok)throw serviceError(res.status);
    const value=await res.json();if(!Array.isArray(value.models))throw fail('ChatGPT 未返回可用模型列表。',502);
    const result=value.models.filter(m=>m.visibility==='list'&&typeof m.slug==='string'&&m.slug&&typeof m.display_name==='string').map(m=>({id:m.slug,label:m.display_name}));
    if(!result.length)throw fail('当前 ChatGPT 账户没有开放可用模型。',502);return result;
  }
  async callback(params,binding){
    const state=params.get('state'),t=this.pending.get(state);if(!t||t.expiresAt<=this.now()||!same(t.binding,binding))throw fail('ChatGPT 登录校验失败或已过期，请重新发起登录。',401);
    this.pending.delete(state);this.processing.add(t.generation);
    try{
      if(params.has('error'))throw fail('你未完成 ChatGPT 授权，原有连接保持不变。');
      const code=params.get('code'),issued=params.get('client_id')||t.clientId;
      if(!code||!issued||issued==='dynamic_agent_client'||t.clientId&&issued!==t.clientId)throw fail('ChatGPT 注册未完成或账户不匹配，请重新登录。',401);
      const raw=await this.tokens({grant_type:'authorization_code',client_id:issued,code,code_verifier:t.verifier,redirect_uri:t.redirectUri,resource:RESOURCE});
      if(typeof raw.id_token!=='string')throw fail('ChatGPT 未返回身份信息，请重新登录。',401);
      let identity;try{identity=await this.verify(raw.id_token,{clientId:issued,nonce:t.nonce,subject:t.profileId?this.profile(t.profileId)?.subject:undefined});}catch{throw fail('ChatGPT 身份校验失败，请重新登录。',401);}
      const old=t.profileId?this.profile(t.profileId):this.store.profiles.find(p=>p.client_id===issued&&p.subject===identity.sub);
      const p={id:old?.id||randomUUID(),label:old?.label||'账户 '+(this.store.profiles.length+1),client_id:issued,subject:identity.sub,email:typeof identity.email==='string'?identity.email:'',issuer:ISSUER,
        ext_agent_host_id:this.hostId,access_token:raw.access_token,refresh_token:typeof raw.refresh_token==='string'?raw.refresh_token:'',id_token:raw.id_token,scopes:scopes(raw.scope),expiresAt:this.now()+raw.expires_in*1000,savedAt:new Date(this.now()).toISOString(),models:[],model:''};
      if(planAllowed(p)){p.models=await this.catalog(p);p.model=p.models.some(m=>m.id===old?.model)?old.model:p.models.find(m=>m.id==='gpt-6-luna')?.id||p.models[0].id;}
      if(t.generation!==this.authRevision)throw fail('这次登录已被新的操作取消，请使用最新的登录窗口。',409);
      const previous=structuredClone(this.store);const index=this.store.profiles.findIndex(x=>x.id===p.id);if(index<0)this.store.profiles.push(p);else this.store.profiles[index]=p;this.store.active=p.id;try{await this.save();}catch{this.store=previous;throw fail('ChatGPT 授权无法保存，原有连接保持不变。',500);}
      this.attempt={state:'done',message:planAllowed(p)?'ChatGPT 登录和套餐授权已完成。':'ChatGPT 已登录，但未授予套餐使用权限，请重新授权。'};return this.publicState();
    }catch(e){const message=e.status?e.message:'ChatGPT 授权未完成，请重新登录。';if(t.generation===this.authRevision)this.attempt={state:'error',message};throw fail(message,e.status||502);}finally{this.processing.delete(t.generation);}
  }
  async access(id){
    const p=this.profile(id);if(!this.isConnected(p))throw fail('请先登录 ChatGPT，并允许工作台使用套餐额度。',503);
    if(p.expiresAt>this.now()+60000)return p.access_token;
    if(!p.refresh_token)throw fail('ChatGPT 授权已过期，请重新登录。',401);
    if(!this.refreshes.has(id)){
      const task=(async()=>{
        const raw=await this.tokens({grant_type:'refresh_token',client_id:p.client_id,refresh_token:p.refresh_token,resource:RESOURCE});
        if(typeof raw.refresh_token!=='string'||!raw.refresh_token)throw fail('ChatGPT 未返回可续期授权，请重新登录。',502);
        if(raw.id_token){try{await this.verify(raw.id_token,{clientId:p.client_id,subject:p.subject});}catch{throw fail('ChatGPT 续期身份校验失败，请重新登录。',401);}}
        const nextScopes=raw.scope===undefined?p.scopes:scopes(raw.scope);if(!planAllowed({scopes:nextScopes}))throw fail('ChatGPT 套餐授权已撤回，请重新登录。',401);
        if(this.profile(id)!==p||!p.refresh_token)throw fail('ChatGPT 连接已断开，请重新登录。',401);
        Object.assign(p,{access_token:raw.access_token,refresh_token:raw.refresh_token,scopes:nextScopes,expiresAt:this.now()+raw.expires_in*1000,...(raw.id_token?{id_token:raw.id_token}:{})});await this.save();return p.access_token;
      })().catch(async e=>{if(e.authExpired)await this.invalidate(id);throw e;}).finally(()=>this.refreshes.delete(id));this.refreshes.set(id,task);
    }
    return this.refreshes.get(id);
  }
  async select(id){if(!this.profile(id))throw fail('ChatGPT 账户不存在。',404);this.authRevision++;this.pending.clear();this.attempt={state:'idle',message:''};this.store.active=id;await this.save();return this.publicState();}
  async setModel(model){const p=this.profile();if(!p||!p.models.some(m=>m.id===model))throw fail('请选择当前 ChatGPT 账户可用的模型。');p.model=model;await this.save();}
  async disconnect(id=this.store.active){
    const p=this.profile(id);if(!p)throw fail('ChatGPT 账户不存在。',404);await this.refreshes.get(id)?.catch(()=>{});let revoked=!p.refresh_token;
    if(p.refresh_token){for(let n=0;n<3;n++){try{const res=await this.request(ISSUER+'/api/accounts/oauth/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:p.refresh_token,token_type_hint:'refresh_token',client_id:p.client_id})});if(res.ok){revoked=true;break;}if(res.status<500)break;}catch{}if(n<2)await new Promise(r=>setTimeout(r,500*2**n));}}
    this.authRevision++;this.pending.clear();await this.invalidate(id);this.attempt={state:'idle',message:''};return {revoked,...this.publicState()};
  }
  async invalidate(id){const p=this.profile(id);if(p){Object.assign(p,{access_token:'',refresh_token:'',id_token:'',scopes:[],expiresAt:0,models:[],model:''});await this.save();}}
  config(){const p=this.profile();if(!this.isConnected(p)||!p.model)throw fail('请先登录 ChatGPT 并完成套餐授权。',503);const id=p.id,model=p.model;return {provider:'chatgpt',chatModel:model,complete:(system,user,options)=>this.complete(id,model,system,user,options)};}
  async complete(id,model,system,user,{onProgress=()=>{}}={}){
    const key=await this.access(id);let res;
    const deadline=this.now()+180000;
    for(let attempt=1;attempt<=3;attempt++){
      try{res=await this.fetch(RESOURCE+'/responses',{method:'POST',redirect:'error',signal:AbortSignal.timeout(Math.max(1,deadline-this.now())),headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model,instructions:system,input:[{role:'user',content:JSON.stringify(user)}],store:false,stream:true})});}catch(e){
        const code=e.cause?.code||e.code,retryable=['UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','EPIPE'].includes(code),delay=1000*2**(attempt-1);
        if(retryable&&attempt<3&&this.now()+delay<deadline){onProgress(`ChatGPT 连接中断，正在重新连接（${attempt}/2）…`);await this.wait(delay);continue;}
        const error=fail(`连接 ChatGPT 失败，原文已保留，请稍后重试。${attempt>1?`已重新连接 ${attempt-1} 次。`:''}`,502);error.details={kind:'connection',attempts:attempt,...(retryable?{networkCode:code}:{})};throw error;
      }
      if(![502,503,504].includes(res.status)||attempt===3)break;
      const delay=1000*2**(attempt-1);if(this.now()+delay>=deadline)break;await res.body?.cancel();onProgress(`ChatGPT 暂时繁忙，正在等待重试（${attempt}/2）…`);await this.wait(delay);
    }
    if(!res.ok){let code='';try{const value=await res.json();code=value.error?.code||'';}catch{}const error=serviceError(res.status,code);if(error.authExpired)await this.invalidate(id);throw error;}
    try{return await readResponsesJSON(res);}catch(e){if(e.authExpired)await this.invalidate(id);if(e.status)throw e;throw fail('ChatGPT 生成连接中断，结果未保存，请重试。',502);}
  }
}
