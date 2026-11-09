// A local Chrome extension document used for model inference, never for scraping.
// All ONNX Runtime executable assets are bundled locally; only WEIGHTS are fetched.
import { env, AutoConfig, AutoModel, AutoTokenizer } from '@huggingface/transformers';
import { MODELS } from './engine.mjs';
import {createDownloadReporter,SETUP_MESSAGE} from './model-status.mjs';

env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useBrowserCache = true;
env.useWasmCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/');
env.backends.onnx.wasm.numThreads = 1;
const encoders = new Map();
function reportState(inference){
  chrome.runtime.sendMessage({target:'background',type:'MODEL_PROGRESS',inference}).catch(()=>{});
}
const reportProgress=createDownloadReporter(reportState);
let queue = Promise.resolve();

async function getEncoder(key) {
  if (!MODELS[key]) throw new Error(`Unknown model: ${key}`);
  if (!encoders.has(key)) {
    const spec = MODELS[key];
    const loading = (async () => {
      reportState({phase:'loading',message:SETUP_MESSAGE});
      if (!navigator.gpu) throw new Error('EmbeddingGemma 2 requires WebGPU. Enable WebGPU or use a compatible Chrome device.');
      // IMPORTANT: do not download the unused vision and audio weights.
      // Model card recommends this manual configuration for text only.
      const config = await AutoConfig.from_pretrained(spec.id,{progress_callback:reportProgress});
      config.vision_config = null;
      config.audio_config = null;
      const [model, tokenizer] = await Promise.all([
        AutoModel.from_pretrained(spec.id, { config, device:'webgpu', dtype:'q4', progress_callback:reportProgress }),
        AutoTokenizer.from_pretrained(spec.id,{progress_callback:reportProgress}),
      ]);
      reportState({phase:'preparing',message:'Preparing EmbeddingGemma 2 on your GPU… This can take a little longer after download.'});
      return async text => {
        const inputs=await tokenizer(`task: classification | query: ${text}`, { truncation: true, max_length: 1600 });
        const outputs=await model(inputs);
        return outputs.sentence_embedding.data;
      };
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
    const embedding=unitVector(await run(String(msg.text||'').slice(0,spec.maxChars)));
    reportState({phase:'ready',message:'Local model ready.'});
    return embedding;
  });
  queue.then(embedding=>sendResponse({ok:true,embedding}),err=>{
    const message=err?.message||String(err);
    const hint=/ort-wasm.*\.mjs|Failed to fetch dynamically imported module|no available backend found/i.test(message)
      ? ' ONNX Runtime executable module missing or inaccessible. Upgrade to v0.1.2, run npm run build, reload extension.'
      : '';
    reportState({phase:'error',message:message+hint});
    sendResponse({ok:false,error:message+hint});
  });
  return true;
});
