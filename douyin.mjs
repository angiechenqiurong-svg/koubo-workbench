import {lookup} from 'node:dns/promises';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';

const MOBILE='Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const DESKTOP='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_HOSTS=new Set(['douyin.com','www.douyin.com','v.douyin.com','iesdouyin.com','www.iesdouyin.com']);
const MEDIA_DOMAINS=['douyin.com','iesdouyin.com','douyinvod.com','bytecdn.com','bytecdn.cn','amemv.com','bytedance.com','zijieapi.com','bytednsdoc.com'];
const error=(message,status=400)=>Object.assign(new Error(message),{status});
export function shareURL(text){
  if(typeof text!=='string'||text.length>10000)throw error('请粘贴一条抖音链接或整段分享文字。');
  const links=text.match(/https?:\/\/[^\s<>"“”]+/g)||[];
  for(const raw of links){try{const u=new URL(raw.replace(/[，。；！）),;!]+$/,''));if(PAGE_HOSTS.has(u.hostname)&&!u.username&&!u.password&&!u.port){u.protocol='https:';u.hash='';return u;}}catch{}}
  throw error('没有找到抖音链接，请从抖音分享菜单复制链接后粘贴。');
}
export function videoID(u){return u.pathname.match(/\/(?:share\/)?video\/(\d{15,22})/)?.[1]||(/^[0-9]{15,22}$/.test(u.searchParams.get('modal_id')||'')?u.searchParams.get('modal_id'):null);}
export function importedDouyin(records,id){return id?[...records].find(r=>r.douyinId===id):undefined;}
export async function validateRemote(value,media=false){
  const u=new URL(value);const ok=media?MEDIA_DOMAINS.some(d=>u.hostname===d||u.hostname.endsWith('.'+d)):PAGE_HOSTS.has(u.hostname);
  if(!ok||!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port)throw error('下载地址不属于抖音支持的域名。');
  const ips=await lookup(u.hostname,{all:true});
  if(!ips.length||ips.some(({address:a})=>a==='::1'||a.startsWith('fc')||a.startsWith('fd')||a.startsWith('fe80:')||/^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(a)))throw error('下载地址不受支持。');
  return u;
}
export async function remote(url,{media=false,headers={},signal}={}){
  let u=await validateRemote(url,media);
  for(let i=0;i<6;i++){
    const r=await fetch(u,{redirect:'manual',headers:{'User-Agent':media?MOBILE:DESKTOP,...headers},signal:signal||AbortSignal.timeout(media?180000:25000)});
    if([301,302,303,307,308].includes(r.status)){
      const location=r.headers.get('location');await r.body?.cancel();if(!location)throw error('抖音链接跳转失败。',502);
      const next=await validateRemote(new URL(location,u),media);if(next.hostname!==u.hostname)delete headers.Cookie;u=next;continue;
    }
    if(!r.ok){await r.body?.cancel();throw error(`抖音暂时无法提供这条视频（${r.status}），请稍后重试。`,502);}return {response:r,url:u};
  }
  throw error('抖音链接跳转过多，请重新复制分享链接。');
}
async function limitedText(response){let size=0;const chunks=[];for await(const c of response.body){size+=c.length;if(size>6*1024*1024)throw error('分享页内容过大。');chunks.push(c);}return Buffer.concat(chunks).toString('utf8');}
export function parsePage(html,id){
  const data=[];
  for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){
    const assignment=m[1].match(/window\._(?:ROUTER|SSR)_DATA\s*=\s*([\s\S]+)/);
    try{if(assignment)data.push(JSON.parse(assignment[1].trim().replace(/;\s*$/,'')));else if(m[0].includes('RENDER_DATA'))data.push(JSON.parse(decodeURIComponent(m[1])));}catch{}
  }
  function find(node){if(!node||typeof node!=='object')return null;if(String(node.aweme_id||node.awemeId||node.id)===id&&node.video)return node;for(const value of Object.values(node)){const result=find(value);if(result)return result;}return null;}
  for(const tree of data){const item=find(tree);if(item)return item;}return null;
}
export async function resolveDouyin(text,onProgress=()=>{},{browser=null,request=remote}={}){
  let u=shareURL(text),id=videoID(u),item;
  onProgress('正在解析抖音分享链接…');
  if(!id){const result=await request(u,{headers:{'User-Agent':MOBILE}});u=result.url;id=videoID(u);if(id)item=parsePage(await limitedText(result.response),id);else{await result.response.body?.cancel();throw error('这个链接不是单条视频。请复制视频的分享链接。');}}
  const sourceUrl=`https://www.douyin.com/video/${id}`;
  if(!item){const {response}=await request(`https://www.iesdouyin.com/share/video/${id}/`,{headers:{'User-Agent':MOBILE}});item=parsePage(await limitedText(response),id);}
  if(!item){const {response}=await request(sourceUrl);item=parsePage(await limitedText(response),id);}
  if(!item&&browser){onProgress('正在网页窗口获取视频，如出现验证请在窗口里完成…');const result=await browser(sourceUrl);if(result?.playUrl)return {id,sourceUrl,playUrl:result.playUrl,title:String(result.title||'抖音视频').slice(0,100),description:String(result.description||'').slice(0,10000),author:''};}
  if(!item)throw error('抖音没有返回可下载的视频信息，可能需要登录或验证。视频尚未导入，请稍后重试或导入本地视频。',502);
  const v=item.video;const urls=[...(v.play_addr?.url_list||v.playAddr?.urlList||[]),...(v.download_addr?.url_list||[])];
  const playUrl=urls.find(x=>typeof x==='string'&&/^https?:/.test(x));if(!playUrl)throw error('这条作品没有可下载的视频，暂不支持图文或直播。');
  return{id,sourceUrl,playUrl,title:String(item.desc||item.description||'抖音视频').slice(0,100),description:String(item.desc||item.description||'').slice(0,10000),author:String(item.author?.nickname||'').slice(0,100)};
}
export async function downloadDouyin(info,file,onProgress=()=>{},{request=remote}={}){
  const {response}=await request(info.playUrl,{media:true,headers:{Referer:info.sourceUrl}});const total=Number(response.headers.get('content-length'))||0;
  if(total>500*1024*1024){await response.body?.cancel();throw error('第一版支持 500MB 以内的视频。',413);}let size=0,last=-1;const hash=createHash('sha256');
  await pipeline(response.body,async function*(source){for await(const chunk of source){size+=chunk.length;if(size>500*1024*1024)throw error('视频超过 500MB。',413);hash.update(chunk);const percent=total?Math.floor(size/total*100):null;if(percent!==last){last=percent;onProgress(total?`正在下载视频… ${percent}%`:'正在下载视频…');}yield chunk;}},createWriteStream(file));
  if(total&&total!==size)throw error('视频下载不完整，请重试。',502);if(!size)throw error('没有收到视频文件。',502);return hash.digest('hex');
}
