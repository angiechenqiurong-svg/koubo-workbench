import puppeteer from 'puppeteer-core';
import {promises as fs} from 'node:fs';
import path from 'node:path';

import {chromePath} from './runtime.mjs';
let busy=false;
let activeBrowser=null;
export async function closeDownloadBrowser(){if(activeBrowser)await activeBrowser.close().catch(()=>{});}
const fail=(message,status=502)=>Object.assign(new Error(message),{status});
export async function browserVideo(url,tempRoot,onProgress=()=>{}){
  if(busy)throw fail('网页解析窗口正在处理另一条视频，请稍后重试。',409);
  const CHROME=chromePath();
  try{if(!CHROME)throw Error('not installed');await fs.access(CHROME);}catch{throw fail('链接解析需要本机 Chrome 浏览器，请安装 Chrome 后重试。',503);}
  busy=true;let browser,profile;
  try{
    profile=await fs.mkdtemp(path.join(tempRoot,'douyin-browser-'));
    browser=await puppeteer.launch({executablePath:CHROME,userDataDir:profile,headless:false,args:['--no-first-run','--no-default-browser-check','--mute-audio'],defaultViewport:{width:1100,height:760},timeout:30000});
    activeBrowser=browser;
    const page=await browser.newPage();
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    const deadline=Date.now()+180000;let last='';
    while(Date.now()<deadline){
      if(page.isClosed())throw fail('获取视频的网页窗口已关闭，下载未完成。');
      const info=await page.evaluate(()=>{
        const videos=Array.from(document.querySelectorAll('video'));
        const v=videos.find(x=>{try{const u=new URL(x.currentSrc||x.src);return x.duration>0&&['douyinvod.com','douyin.com','bytecdn.com','bytecdn.cn','amemv.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d));}catch{return false;}});
        const title=document.querySelector('h1')?.innerText||document.title;
        return {playUrl:v?.currentSrc||v?.src||'',title,description:document.querySelector('h1')?.innerText||'',pageUrl:location.href};
      });
      if(info.playUrl){const actual=new URL(info.pageUrl),expected=new URL(url);if(actual.pathname!==expected.pathname)throw fail('网页已切换到其他视频，请重新粘贴原链接。');return info;}
      const message=/验证码|安全验证/.test(info.title)?'请在抖音网页窗口完成验证码，完成后会继续下载。':'正在正常网页窗口读取视频，请保持窗口打开…';
      if(message!==last){last=message;onProgress(message);}
      await new Promise(resolve=>setTimeout(resolve,1200));
    }
    throw fail('网页未返回视频。请在弹出的窗口完成验证或播放视频后重试。');
  }catch(e){if(e.status)throw e;throw fail('抖音网页获取失败，请检查网络，或重新粘贴链接。');}
  finally{if(browser)await browser.close().catch(()=>{});activeBrowser=null;if(profile)await fs.rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});busy=false;}
}
