// A local Chrome extension document used for model inference, never for scraping.
// All ONNX Runtime executable assets are bundled locally; only WEIGHTS are fetched.
import { pipeline, env, AutoConfig, AutoModel, AutoTokenizer } from '@huggingface/transformers';
import { MODELS } from './engine.mjs';

env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useBrowserCache = true;
env.useWasmCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/');
env.backends.onnx.wasm.numThreads = 1;
const encoders = new Map();
let lastReported=-1;
function reportProgress(e){
  const p=Number(e?.progress);
  const bucket=Number.isFinite(p)?Math.floor(p/5)*5:null;
  if(bucket!==null && bucket!==lastReported){
    lastReported=bucket;
    chrome.runtime.sendMessage({target:'background',type:'MODEL_PROGRESS',detail:`Downloading model: ${bucket}%`}).catch(()=>{});
  }
}
let queue = Promise.resolve();

async function getEncoder(key) {
  if (!MODELS[key]) throw new Error(`Unknown model: ${key}`);
  if (!encoders.has(key)) {
    const spec = MODELS[key];
    const loading = (async () => {
      if (key === 'gemma') {
        if (!navigator.gpu) throw new Error('EmbeddingGemma 2 requires WebGPU. Select MiniLM in extension settings.');
        // IMPORTANT: do not download the unused vision and audio weights.
        // Model card recommends this manual configuration for text only.
        const config = await AutoConfig.from_pretrained(spec.id);
        config.vision_config = null;
        config.audio_config = null;
        const [model, tokenizer] = await Promise.all([
          AutoModel.from_pretrained(spec.id, { config, device:'webgpu', dtype:'q4', progress_callback:reportProgress }),
          AutoTokenizer.from_pretrained(spec.id),
        ]);
        return async text => {
          const inputs=await tokenizer(`task: classification | query: ${text}`, { truncation: true, max_length: 1600 });
          const outputs=await model(inputs);
          return outputs.sentence_embedding.data;
        };
      }
      const pipe = await pipeline('feature-extraction', spec.id, {device:'wasm',dtype:'q8',progress_callback:reportProgress});
      return async text => (await pipe(text, { pooling:'mean',normalize:true, truncation:true, max_length:256 })).data;
    })();
    encoders.set(key,loading);
    loading.catch(()=>encoders.delete(key));
  }
  return encoders.get(key);
}
function unitVector(arr) {
  const v=Array.from(arr, Number);
  let s=0;for(const x of v)s+=x*x;
  if(s<1e-14) throw new Error('Embedding model returned a zero vector');
  return v.map(x=>x/Math.sqrt(s));
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'PING') { sendResponse({ok:true}); return; }
  if (msg.type !== 'EMBED') return;
  // Serialize GPU/ONNX calls; parallel inference can exhaust browser memory.
  queue=queue.catch(()=>{}).then(async()=>{
    const spec=MODELS[msg.model];
    if(!spec)throw new Error('Unknown embedding model');
    const run=await getEncoder(msg.model);
    return unitVector(await run(String(msg.text||'').slice(0,spec.maxChars)));
  });
  queue.then(embedding=>sendResponse({ok:true,embedding}),err=>{
    const message=err?.message||String(err);
    const hint=/ort-wasm.*\.mjs|Failed to fetch dynamically imported module|no available backend found/i.test(message)
      ? ' ONNX Runtime executable module missing or inaccessible. Upgrade to v0.1.2, run npm run build, reload extension.'
      : '';
    sendResponse({ok:false,error:message+hint});
  });
  return true;
});
