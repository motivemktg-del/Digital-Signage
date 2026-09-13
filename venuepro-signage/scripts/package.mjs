import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, relative, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const entries=['package.json','pnpm-lock.yaml','server.js','store.js','agency.js','studio.js','tenant.js','public','android','Dockerfile','compose.yml','.dockerignore','.env.example','README.md','INSTALL-APPS.md','STUDIO-IA.md','.gitignore','install.sh','scripts','test'];
const ignored=new Set(['build','.gradle','node_modules','local.properties']);
const files=[];
function walk(path){for(const item of readdirSync(path,{withFileTypes:true})){if(ignored.has(item.name))continue;const full=join(path,item.name);if(item.isDirectory())walk(full);else if(item.isFile())files.push(relative(root,full).replaceAll('\\','/'));}}
for(const entry of entries){if(['public','android','scripts','test'].includes(entry))walk(join(root,entry));else files.push(entry);}
files.sort();
writeFileSync(join(root,'SHA256SUMS'),files.map(path=>createHash('sha256').update(readFileSync(join(root,path))).digest('hex')+'  '+path).join('\n')+'\n');
mkdirSync(join(root,'output'),{recursive:true});
execFileSync(process.platform==='win32'?'tar.exe':'tar',['-czf',join(root,'output/venuepro-signage-source.tar.gz'),'-C',root,...files,'SHA256SUMS']);
console.log(`Paquete creado: ${files.length} archivos verificados, APK incluida.`);
