import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const result=spawnSync('python3',[path.join(root,'scripts','package.py')],{cwd:root,stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status||0;
