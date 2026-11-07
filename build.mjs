import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
const root=import.meta.dirname;
for(const dir of ['package/lib','package/static'])for(const file of readdirSync(join(root,dir)))if(/\.(mjs|js)$/.test(file))execFileSync(process.execPath,['--check',join(root,dir,file)]);
for(const file of ['.aux4','app.json','component.json'])JSON.parse(readFileSync(join(root,'package',file),'utf8'));
console.log('Phone package validated');
