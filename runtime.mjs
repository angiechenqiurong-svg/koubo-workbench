import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {existsSync} from 'node:fs';
const require=createRequire(import.meta.url);
export const FFMPEG=process.env.KOUBO_FFMPEG||require('@ffmpeg-installer/ffmpeg').path;
export const FFPROBE=process.env.KOUBO_FFPROBE||require('@ffprobe-installer/ffprobe').path;
export function chromePath(){
  const candidates=process.env.KOUBO_CHROME?[process.env.KOUBO_CHROME]:[
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(),'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  ];
  return candidates.find(p=>existsSync(p));
}
