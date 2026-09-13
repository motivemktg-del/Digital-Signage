import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
const signagePath=process.env.SIGNAGE_ENV_PATH||'/signage/.env';
const crmPath=process.env.CRM_ENV_PATH||'/crm-env/backend.env';
try {
 let input='';for await(const chunk of process.stdin)input+=chunk;
 const crm=JSON.parse(input),previous=existsSync(signagePath)?readFileSync(signagePath,'utf8'):null;
 const current=previous===null?{}:parseEnv(previous);
 const crmFile=readFileSync(crmPath,'utf8'),savedCrm=parseEnv(crmFile);
 const existingCrmSecret=savedCrm.AGENCY_SIGNAGE_SECRET||crm.AGENCY_SIGNAGE_SECRET;
 if(current.AGENCY_SIGNAGE_SECRET&&existingCrmSecret&&current.AGENCY_SIGNAGE_SECRET!==existingCrmSecret)throw Error('Las claves de integración existentes son diferentes. Revisa ambas configuraciones antes de continuar.');
 const secret=current.AGENCY_SIGNAGE_SECRET||existingCrmSecret||randomBytes(32).toString('hex');
 if(secret.length<32)throw Error('La clave de integración requiere al menos 32 caracteres.');
 const encode=value=>JSON.stringify(String(value).replaceAll('$','$$'));
 if(previous===null){
  if(!crm.BUNNY_STORAGE_ZONE||!crm.BUNNY_STORAGE_PASSWORD)throw Error('Configura Bunny Storage en el CRM antes del despliegue.');
  if(!process.env.TRAEFIK_NETWORK)throw Error('No se pudo determinar la red del proxy.');
  const config={PORT:'3080',PUBLIC_URL:'https://ds.venueprocrm.cloud',DATA_DIR:'/app/data',STORAGE_MODE:'bunny',BUNNY_STORAGE_HOST:crm.BUNNY_STORAGE_HOST||'storage.bunnycdn.com',BUNNY_STORAGE_ZONE:crm.BUNNY_STORAGE_ZONE,BUNNY_STORAGE_PASSWORD:crm.BUNNY_STORAGE_PASSWORD,TRAEFIK_NETWORK:process.env.TRAEFIK_NETWORK,AGENCY_SIGNAGE_SECRET:secret};
  writeFileSync(signagePath,Object.entries(config).map(([k,v])=>`${k}=${encode(v)}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
 }else if(!current.AGENCY_SIGNAGE_SECRET){
  copyFileSync(signagePath,signagePath+'.signage-backup');
  writeFileSync(signagePath,previous.replace(/^AGENCY_SIGNAGE_SECRET=.*\r?\n?/gm,'')+'\nAGENCY_SIGNAGE_SECRET='+encode(secret)+'\n',{mode:0o600});
 }
 const updated=crmFile.replace(/^(?:SIGNAGE_URL|AGENCY_SIGNAGE_SECRET)=.*\r?\n?/gm,'').trimEnd()+'\nSIGNAGE_URL=https://ds.venueprocrm.cloud\nAGENCY_SIGNAGE_SECRET='+encode(secret)+'\n';
 if(updated!==crmFile){
  copyFileSync(crmPath,crmPath+'.signage-backup');
  writeFileSync(crmPath+'.signage-next',updated,{mode:0o600});renameSync(crmPath+'.signage-next',crmPath);
 }
 console.log('Bunny y vínculo de agencia configurados; las claves no se muestran.');
}catch(error){console.error(error instanceof SyntaxError?'No se pudo leer la configuración del CRM.':error.message);process.exit(1);}
