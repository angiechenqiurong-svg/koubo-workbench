import puppeteer from 'puppeteer-core';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {parsePage,videoID} from './douyin.mjs';

import {chromePath} from './runtime.mjs';
let busy=false;
let activeBrowser=null;
export async function closeDownloadBrowser(){if(activeBrowser)await activeBrowser.close().catch(()=>{});}
const fail=(message,status=502)=>Object.assign(new Error(message),{status});
export async function browserVideo(url,tempRoot,onProgress=()=>{},platform='douyin'){
  const platformName=platform==='xiaohongshu'?'小红书':'抖音';
  const domains=platform==='xiaohongshu'?['xhscdn.com','xiaohongshu.com']:['douyinvod.com','douyin.com','bytecdn.com','bytecdn.cn','amemv.com'];
  if(busy)throw fail('网页解析窗口正在处理另一条视频，请稍后重试。',409);
  const CHROME=chromePath();
  try{if(!CHROME)throw Error('not installed');await fs.access(CHROME);}catch{throw fail('链接解析需要本机 Chrome 浏览器，请安装 Chrome 后重试。',503);}
  busy=true;let browser,profile;
  try{
    profile=path.join(tempRoot,platform+'-session');
    await fs.mkdir(profile,{recursive:true});
    browser=await puppeteer.launch({executablePath:CHROME,userDataDir:profile,headless:false,args:['--no-first-run','--no-default-browser-check','--mute-audio'],defaultViewport:{width:1100,height:760},timeout:30000});
    activeBrowser=browser;
    const page=await browser.newPage();
    const media=new Set();let detail;
    const expectedId=videoID(new URL(url));
    page.on('response',async response=>{
      try{
        const address=new URL(response.url()),type=response.headers()['content-type']||'';
        const allowed=domains.some(d=>address.hostname===d||address.hostname.endsWith('.'+d));
        if(allowed&&/video\/mp4/.test(type))media.add(address.href);
        if(platform==='douyin'&&/json/.test(type)&&/aweme|detail/.test(address.pathname)){
          const raw=await response.text();if(raw.length>6*1024*1024)return;
          const item=parsePage('<script>window._ROUTER_DATA = '+raw+'</script>',expectedId);
          const play=item?.video?.play_addr?.url_list?.[0];
          if(play)detail={playUrl:play,title:item.desc||'抖音视频',description:item.desc||'',pageUrl:url};
        }
      }catch{}
    });
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    const deadline=Date.now()+180000;let last='';
    while(Date.now()<deadline){
      if(page.isClosed())throw fail('获取视频的网页窗口已关闭，下载未完成。');
      const info=await page.evaluate(domains=>{
        const videos=Array.from(document.querySelectorAll('video'));
        const v=videos.find(x=>{try{const u=new URL(x.currentSrc||x.src);return x.duration>0&&domains.some(d=>u.hostname===d||u.hostname.endsWith('.'+d));}catch{return false;}});
        const title=document.querySelector('h1')?.innerText||document.title;
        return {playUrl:v?.currentSrc||v?.src||'',title,description:document.querySelector('h1')?.innerText||'',pageUrl:location.href};
      },domains);
      const pageURL=new URL(info.pageUrl);
      if(platform==='xiaohongshu'&&pageURL.pathname.startsWith('/404'))throw fail('小红书返回“当前笔记暂时无法浏览”。请从 App 重新复制完整分享链接后回填重试。',410);
      const captured=detail||info;
      if(!captured.playUrl&&media.size===1)captured.playUrl=[...media][0];
      if(captured.playUrl){const actual=new URL(info.pageUrl),expected=new URL(url);if(actual.pathname!==expected.pathname)throw fail('网页已切换到其他视频，请重新粘贴原链接。');return captured;}
      const message=/验证码|安全验证|登录/.test(info.title)?`请在${platformName}独立网页窗口自行完成验证或登录，工具不读取主浏览器账户。`:`正在${platformName}独立网页窗口读取视频；如需验证，请在窗口完成。`;
      if(message!==last){last=message;onProgress(message);}
      await new Promise(resolve=>setTimeout(resolve,1200));
    }
    throw fail('网页未返回视频。链接和访问会话已保留，请点击重试；出现验证时在辅助窗口完成。');
  }catch(e){if(e.status)throw e;throw fail(`${platformName}网页获取失败，链接已保留，请重试。`);}
  finally{if(browser)await browser.close().catch(()=>{});activeBrowser=null;busy=false;}
}
