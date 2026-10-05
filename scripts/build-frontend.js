import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
// Static ES modules are the deployment artifact; no bundler or duplicate runtime.
const assets=['public/index.html','public/app.js','public/workspace.js','public/social-workspace.js','public/styles.css','public/privacy.html','public/policies.html'];
for(const file of assets){assert.ok(fs.statSync(file).size>0,file);if(file.endsWith('.js'))assert.equal(spawnSync(process.execPath,['--check',file],{stdio:'inherit'}).status,0,file);}
const html=fs.readFileSync('public/index.html','utf8');
for(const file of ['app.js','styles.css'])assert.ok(html.includes('/'+file),file+' entry point');
assert.ok(fs.readFileSync('public/app.js','utf8').includes("import('./workspace.js')"),'Lazy workspace module');
console.log(JSON.stringify({staticBuild:'passed',assets:assets.length,compressedApplicationBytes:gzipSync(fs.readFileSync('public/app.js')).length+gzipSync(fs.readFileSync('public/workspace.js')).length}));
