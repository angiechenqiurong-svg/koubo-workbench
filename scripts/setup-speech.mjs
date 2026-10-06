import {spawnSync,spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
if(process.platform!=='darwin')throw Error('当前安装入口支持 macOS。其他平台尚未验证。');
const candidates=process.env.KOUBO_PYTHON?[process.env.KOUBO_PYTHON]:['python3.12','python3.11','python3.10','python3.9','python3'];
const python=candidates.find(p=>spawnSync(p,['-c','import sys;sys.exit(0 if (3,9)<=sys.version_info[:2]<=(3,12) else 1)'],{stdio:'ignore'}).status===0);
if(!python)throw Error('请先安装 Python 3.11 或 3.12，再重新运行安装入口：https://www.python.org/downloads/macos/');
async function run(exe,args){await new Promise((resolve,reject)=>{const p=spawn(exe,args,{stdio:'inherit'});p.on('error',reject);p.on('close',code=>code===0?resolve():reject(Error('安装未完成，请检查网络后重试。')));});}
console.log('正在准备本机中文识别环境…');
await run(python,['-m','venv','.speech-env']);
const speechPython=path.join(root,'.speech-env','bin','python');
await run(speechPython,['-m','pip','install','-r','requirements-speech.txt']);
console.log('正在下载中文识别模型（约 150 MB，首次需要联网）…');
await run(speechPython,[path.join(root,'scripts','download-model.py')]);
const swift=spawnSync('xcrun',['--find','swiftc'],{encoding:'utf8'});
if(swift.status===0){
  console.log('正在准备画面字幕识别…');
  const cache=await fs.mkdtemp('/private/tmp/koubo-swift-');
  try{await run('swiftc',['-module-cache-path',cache,path.join(root,'subtitles.swift'),'-o',path.join(root,'subtitles-ocr')]);}
  catch{console.log('画面字幕组件未编译成功，仍可使用音频听写。');}
  finally{await fs.rm(cache,{recursive:true,force:true});}
}else console.log('未检测到 Apple 开发工具，已启用音频听写。需要字幕识别时，先安装 Apple Command Line Tools 后重新运行本入口。');
console.log('本机中文识别已准备完成。');
