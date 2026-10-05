import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
for(const file of [...fs.readdirSync('src/social').filter(f=>f.endsWith('.js')).map(f=>path.join('src/social',f)),'src/account-currency.js','src/currency-rates.js','public/social-workspace.js']){if(spawnSync(process.execPath,['--check',file],{stdio:'inherit'}).status!==0)process.exit(1);}
console.log('Social modules: syntax passed');
