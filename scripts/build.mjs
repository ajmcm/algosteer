import { build } from 'esbuild';
import { cp, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root=resolve(import.meta.dirname,'..'), dist=join(root,'dist');
await rm(dist,{recursive:true,force:true}); await mkdir(dist,{recursive:true});
for(const filename of ['manifest.json'])await copyFile(join(root,filename),join(dist,filename));
for(const filename of ['offscreen.html','popup.html','popup.css','content.css'])await copyFile(join(root,'src',filename),join(dist,filename));
for(const [name, entry] of Object.entries({
 background:'src/background.js', offscreen:'src/offscreen.js',
 content:'src/content.js', popup:'src/popup.js'
})){
 await build({entryPoints:[join(root,entry)],outfile:join(dist,`${name}.js`),
  bundle:true,format:name==='background'||name==='offscreen'?'esm':'iife',
  platform:'browser',target:'chrome120',minify:false,legalComments:'none',
  mainFields:['browser','module','main'],conditions:['browser'],
  logLevel:'warning',
 });
}
// ONNX Runtime Web's runtime comprises paired executable .mjs modules and .wasm
// binaries. The v0.1.1 build copied only .wasm, causing "Failed to fetch
// dynamically imported module: .../ort-wasm-simd-threaded.asyncify.mjs".
// NEVER fetch these executable assets from a CDN inside an MV3 extension.
// Use one resolved ORT package, not a mixture of different dependency versions.
const candidates=[
 join(root,'node_modules','@huggingface','transformers','node_modules','onnxruntime-web','dist'),
 join(root,'node_modules','onnxruntime-web','dist'),
];
const required=[
 'ort-wasm-simd-threaded.asyncify.mjs',
 'ort-wasm-simd-threaded.asyncify.wasm',
];
let selected=null, available=[];
for(const dir of candidates){
 try {
  const entries=await readdir(dir);
  if(required.every(name=>entries.includes(name))){selected=dir;available=entries;break;}
 }catch{}
}
if(!selected){
 throw new Error('Missing ONNX Runtime executable assets: '+required.join(', ')+
  '. Check node_modules/onnxruntime-web/dist/ (or its nested installation), and run npm install.');
}
const runtimeDir=join(dist,'wasm');
await mkdir(runtimeDir,{recursive:true});
const copied=[];
for(const filename of available){
 if(/^ort-wasm.*\.(mjs|wasm)$/.test(filename)){
  await copyFile(join(selected,filename),join(runtimeDir,filename));
  copied.push(filename);
 }
}
// Fail the build when any Emscripten module is missing its matching binary.
for(const filename of copied.filter(name=>name.endsWith('.mjs'))){
 const paired=filename.slice(0,-4)+'.wasm';
 if(!copied.includes(paired))throw new Error(`ONNX Runtime module ${filename} has no matching ${paired}`);
}
for(const filename of required){
 const info=await stat(join(runtimeDir,filename));
 if(!info.isFile()||info.size===0)throw new Error(`ONNX Runtime runtime asset is empty: ${filename}`);
}
console.log(`Built ${dist} with ${copied.length} local ONNX Runtime .mjs + .wasm assets from ${selected}.`);
console.log('Chrome → chrome://extensions → Reload the EXISTING extension, then refresh LinkedIn.');
