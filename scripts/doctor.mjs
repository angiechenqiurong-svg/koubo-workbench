import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {FFMPEG,FFPROBE,chromePath} from '../runtime.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let bad=false;
function check(label,ok,help=''){console.log(`${ok?'✓':'✗'} ${label}${ok?'':': '+help}`);if(!ok)bad=true;}
check('Node.js 22 或更新版本',Number(process.versions.node.split('.')[0])>=22,'请安装 Node.js 22 或 24。');
check('视频处理组件',spawnSync(FFMPEG,['-version'],{stdio:'ignore'}).status===0,'重新运行 npm ci。');
check('视频信息组件',spawnSync(FFPROBE,['-version'],{stdio:'ignore'}).status===0,'重新运行 npm ci。');
check('Google Chrome',!!chromePath(),'请安装 Google Chrome。');
const python=path.join(root,'.speech-env','bin','python');
check('本机中文识别',spawnSync(python,['-c','import faster_whisper,opencc'],{stdio:'ignore'}).status===0,'运行“首次安装.command”。');
check('中文识别模型',['config.json','model.bin','tokenizer.json','vocabulary.txt'].every(f=>existsSync(path.join(root,'.speech-model',f))),'运行“首次安装.command”。');
console.log(existsSync(path.join(root,'subtitles-ocr'))?'✓ 画面字幕识别已安装':'○ 画面字幕识别可选，当前使用音频听写。');
process.exitCode=bad?1:0;
