import {promises as fs,createReadStream,createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FFMPEG,FFPROBE} from './runtime.mjs';
import {resolveDouyin,downloadDouyin,videoID,remote} from './douyin.mjs';
import {browserVideo} from './browser.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const fail=(message,status=502)=>Object.assign(new Error(message),{status});
export const platformNames={douyin:'抖音',bilibili:'B 站',xiaohongshu:'小红书',youtube:'YouTube'};
const hosts={douyin:['douyin.com','www.douyin.com','v.douyin.com','iesdouyin.com','www.iesdouyin.com'],bilibili:['bilibili.com','www.bilibili.com','m.bilibili.com','b23.tv'],xiaohongshu:['xiaohongshu.com','www.xiaohongshu.com','m.xiaohongshu.com','xhslink.com','www.xhslink.com'],youtube:['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtube-nocookie.com']};
export function videoLink(text){
  if(typeof text!=='string'||text.length>10000)throw fail('请粘贴一条视频分享链接或分享文字。',400);
  for(const raw of text.match(/https?:\/\/[^\s<>"“”]+/g)||[]){
    try{
      const url=new URL(raw.replace(/[，。；！）),;!]+$/,''));
      const platform=Object.keys(hosts).find(p=>hosts[p].includes(url.hostname));
      if(!platform||url.username||url.password||url.port)continue;
      url.protocol='https:';url.hash='';
      if(platform==='xiaohongshu'&&!url.hostname.endsWith('xhslink.com'))url.hostname='www.xiaohongshu.com';
      if(platform==='bilibili'&&url.hostname!=='b23.tv')url.hostname='www.bilibili.com';
      if(platform==='youtube'&&!(/\/watch$|\/shorts\/|\/live\//.test(url.pathname)||url.hostname==='youtu.be'))continue;
      let id=platform==='douyin'?videoID(url):platform==='youtube'?(url.searchParams.get('v')||url.pathname.split('/').filter(Boolean).at(-1)):platform==='bilibili'?url.pathname.match(/\/(BV[a-zA-Z0-9]+|av\d+)/)?.[1]:url.pathname.match(/\/(?:explore|(?:discovery\/)?item)\/([a-zA-Z0-9]+)/)?.[1];
      if(platform==='bilibili'&&id)id+=':p'+(url.searchParams.get('p')||'1');
      return {url,platform,label:platformNames[platform],sourceKey:id?`${platform}:${id}`:null};
    }catch{}
  }
  throw fail('请粘贴抖音、B 站、小红书或 YouTube 的单条视频链接。',400);
}
export async function resolvePlatformLink(link,{request=fetch}={}){
  let url=link.url;
  if(!['b23.tv','xhslink.com','www.xhslink.com'].includes(url.hostname))return link;
  for(let i=0;i<6;i++){
    const response=await request(url,{redirect:'manual',signal:AbortSignal.timeout(25000)});
    const location=response.headers.get('location');await response.body?.cancel();
    if([301,302,303,307,308].includes(response.status)&&location){const next=videoLink(new URL(location,url).href);if(next.platform!==link.platform)throw fail('短链接跳转到了其他平台，请重新复制原视频分享链接。');url=next.url;continue;}
    if(!response.ok)throw fail('短链接暂时不可访问，请复制完整分享链接重试。');
    return videoLink(url.href);
  }
  throw fail('分享链接跳转过多，请复制完整视频链接重试。');
}
export function downloaderMessage(raw,platform){
  const name=platformNames[platform]||'平台';
  if(platform==='xiaohongshu'&&/No video formats/.test(raw))return '小红书页面没有返回视频信息，可能需要有效的完整分享参数或登录验证。原链接已保留，可回填新的分享链接，或启用可选解析服务。';
  if(/Sign in|login|cookies|登录|验证|412|403|captcha|bot/i.test(raw))return `${name}需要访问验证或登录。链接已保留，可重试或启用可选解析服务，也可导入本地视频。`;
  if(/timeout|timed out|network|resolve|connection/i.test(raw))return `连接${name}超时或网络不可达。链接已保留，请检查网络后点击重试。`;
  if(/private|deleted|unavailable|removed|not found|404/i.test(raw))return `${name}这条视频不可访问，可能已删除或设为私密。请在平台确认后重试。`;
  if(/60 分钟|500MB|直播/.test(raw))return raw.slice(-160);
  return `${name}没有返回可下载的视频。请确认是公开视频的完整分享链接（小红书建议保留分享参数），然后重试。`;
}
async function run(exe,args,{onLine=()=>{},timeout=600000,env={}}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});let buffer='',out='',error='',finished=false;
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(fail('视频处理超时，链接已保留，请重试。',504));},timeout);
    child.stdout.on('data',chunk=>{out+=chunk;if(out.length>8*1024*1024){child.kill();return;}buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines)onLine(line);});
    child.stderr.on('data',chunk=>error=(error+chunk).slice(-3000));
    child.on('error',()=>{clearTimeout(timer);reject(fail('多平台下载组件尚未安装，请运行安装入口。',503));});
    child.on('close',code=>{clearTimeout(timer);if(buffer)onLine(buffer);if(code===0)resolve(out);else reject(fail(error||'平台下载未完成。'));});
  });
}
export async function ytDownload(link,folder,progress){
  const tools=path.join(folder,'tools');await fs.mkdir(tools);
  await fs.symlink(FFMPEG,path.join(tools,'ffmpeg'));await fs.symlink(FFPROBE,path.join(tools,'ffprobe'));
  let result,reason='';
  try{await run(path.join(ROOT,'.speech-env/bin/python'),[path.join(ROOT,'download-video.py'),link.url.href,folder,tools,process.execPath],{onLine:line=>{try{const value=JSON.parse(line);if(value.progress)progress(value.progress);if(value.done)result=value;if(value.error)reason=value.error;}catch{}}});}
  catch(error){throw fail(downloaderMessage(reason||error.message,link.platform));}
  if(!result?.file||!path.resolve(result.file).startsWith(path.resolve(folder)+path.sep))throw fail('下载组件没有返回有效的视频文件。');
  const stat=await fs.stat(result.file);if(stat.size>500*1024*1024)throw fail('视频超过 500MB。',413);
  return {...result,sourcePlatform:link.platform,sourceKey:link.sourceKey||`${link.platform}:${result.id}`,channel:'local'};
}
export async function publicMediaURL(value){
  const url=new URL(value);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port)throw fail('解析服务返回了不支持的视频地址。');
  const addresses=await lookup(url.hostname,{all:true});
  if(!addresses.length||addresses.some(({address:a})=>a==='::1'||a.startsWith('fc')||a.startsWith('fd')||a.startsWith('fe80')||a.startsWith('::ffff:')||/^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(a)))throw fail('解析服务返回了不支持的视频地址。');
  return url;
}
async function serviceMedia(value,file,referer){
  let url=await publicMediaURL(value);
  for(let i=0;i<6;i++){
    const response=await fetch(url,{redirect:'manual',headers:referer?{Referer:referer}:{},signal:AbortSignal.timeout(180000)});
    if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();url=await publicMediaURL(new URL(response.headers.get('location'),url));continue;}
    if(!response.ok)throw fail('解析服务的视频下载地址已失效，请重试。');
    let size=0;await pipeline(response.body,async function*(source){for await(const chunk of source){size+=chunk.length;if(size>500*1024*1024)throw fail('视频超过 500MB。',413);yield chunk;}},createWriteStream(file));
    if(!size)throw fail('解析服务没有返回视频内容。');return;
  }
  throw fail('解析服务的视频地址跳转过多。');
}
export async function anyToCopy(link,settings,folder,progress,{request=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  if(!settings.parserEnabled||!settings.parserKey||!settings.parserSecret)throw fail('请先配置并启用可选解析服务。',503);
  const base='https://api.anytocopy.com/vip/open-api/v1';
  const headers={'X-API-Key':settings.parserKey,'X-API-Secret':settings.parserSecret};
  progress('正在通过已启用的解析服务提取视频与文案…');
  async function api(url,method='GET'){const response=await request(url,{method,headers,signal:AbortSignal.timeout(30000)});if(!response.ok)throw fail(`解析服务返回错误（${response.status}），请检查专业版额度和密钥。`);const value=await response.json();if(value.code!==200)throw fail('解析服务拒绝了任务，请检查专业版额度或稍后重试。');return value.data;}
  const task=await api(`${base}/video/extract?workUrl=${encodeURIComponent(link.url.href)}&taskType=TEXT`,'POST');
  for(let i=0;i<60;i++){
    await pause(3000);const value=await api(`${base}/video/query?taskId=${encodeURIComponent(task)}`);
    if(value.status==='SUCCESS')return {id:String(value.taskId),sourceUrl:link.url.href,sourcePlatform:link.platform,sourceKey:link.sourceKey||link.url.href,title:String(value.title||'视频').slice(0,100),author:'',description:String(value.content||''),textContent:String(value.textContent||''),playUrl:value.videoUrl||value.videoUrlList?.[0],channel:'service'};
    if(['FAILURE','FAILED'].includes(value.status))throw fail('解析服务未能提取这条视频，链接已保留，可稍后重试。');
  }
  throw fail('解析服务处理超时，链接已保留，请稍后重试。',504);
}
export async function fetchVideo(link,folder,progress,settings={},extract=true){
  link=await resolvePlatformLink(link);
  let primary;
  if(link.platform==='douyin'){
    try{const info=await resolveDouyin(link.url.href,progress);const file=path.join(folder,'native.mp4');await downloadDouyin(info,file,progress);return {...info,file,sourcePlatform:'douyin',sourceKey:`douyin:${info.id}`,channel:'local'};}catch(error){primary=error;}
  }
  try{return await ytDownload(link,folder,progress);}catch(error){primary=error;}
  let serviceError;
  if(settings.parserEnabled&&extract){try{const info=await anyToCopy(link,settings,folder,progress);if(!info.playUrl)throw fail('解析服务未返回视频下载地址。');const file=path.join(folder,'service.mp4');await serviceMedia(info.playUrl,file);return {...info,file};}catch(error){serviceError=error;}}
  if(link.platform==='douyin'){
    try{const info=await resolveDouyin(link.url.href,progress,{request:async(url,options)=>videoID(new URL(url))?{response:new Response(''),url:new URL(url)}:remote(url,options),browser:url=>browserVideo(url,path.dirname(folder),progress)});const file=path.join(folder,'browser.mp4');await downloadDouyin(info,file,progress);return {...info,file,sourcePlatform:'douyin',sourceKey:`douyin:${info.id}`,channel:'browser'};}catch(error){primary=error;}
  }
  if(link.platform==='xiaohongshu'){
    try{progress('本机解析未返回视频，正在打开小红书独立验证窗口…');const info=await browserVideo(link.url.href,path.dirname(folder),progress,'xiaohongshu');const file=path.join(folder,'browser.mp4');await serviceMedia(info.playUrl,file,link.url.href);return {...info,file,id:link.sourceKey?.split(':')[1]||'video',sourceUrl:link.url.href,sourcePlatform:link.platform,sourceKey:link.sourceKey||link.url.href,channel:'browser'};}catch(error){primary=error;}
  }
  throw serviceError||primary;
}
export async function installVideo(info,destination){
  const raw=JSON.parse(await run(FFPROBE,['-v','quiet','-show_streams','-of','json',info.file]));
  const video=raw.streams?.find(s=>s.codec_type==='video'),audio=raw.streams?.find(s=>s.codec_type==='audio');
  if(!video)throw fail('获取的文件没有可播放的视频。');
  if(video.codec_name==='h264'&&(!audio||audio.codec_name==='aac'))await run(FFMPEG,['-v','error','-y','-i',info.file,'-map','0:v:0','-map','0:a:0?','-c','copy','-movflags','+faststart',destination]);
  else await run(FFMPEG,['-v','error','-y','-i',info.file,'-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','fast','-crf','23','-c:a','aac','-movflags','+faststart',destination]);
  if((await fs.stat(destination)).size>500*1024*1024)throw fail('处理后视频超过 500MB。',413);
  const hash=createHash('sha256');for await(const chunk of createReadStream(destination))hash.update(chunk);return hash.digest('hex');
}
