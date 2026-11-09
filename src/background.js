import {SETUP_MESSAGE} from './model-status.mjs';
import { BayesianRFF, DEFAULTS, MODELS, decide, fnv1a, normalizeText } from './engine.mjs';
const SETTINGS_KEY='settings-v1', LABELS_KEY='labels-v1';
let initialized=null, settings={...DEFAULTS}, labels=[], model=null, embeddingDim=0;
const memoryCache=new Map();
const MAX_CACHE=250;
let creatingDocument=null, opQueue=Promise.resolve();
let status='idle';
let inference={phase:'idle',message:''};
let embeddingUpgradeNeeded=false;

async function initialize(){
  if(!initialized) initialized=(async()=>{
    const values=await chrome.storage.local.get([SETTINGS_KEY,LABELS_KEY]);
    settings={...DEFAULTS,...(values[SETTINGS_KEY]||{})};
    labels=Array.isArray(values[LABELS_KEY])?values[LABELS_KEY]:[];
    embeddingUpgradeNeeded=labels.length>0 && (!MODELS[settings.model] || labels.some(r=>
      !Array.isArray(r.embedding) || r.embedding.length!==MODELS[DEFAULTS.model].embeddingDim));
    settings.model=DEFAULTS.model;
    if(embeddingUpgradeNeeded) status='Saved ratings will be upgraded to EmbeddingGemma 2 when you next score or rate a post.';
    else rebuild();
  })().catch(e=>{initialized=null;throw e});
  return initialized;
}
async function upgradeEmbeddings(){
  if(!embeddingUpgradeNeeded)return;
  // Keep the original records and stored settings intact until every inference succeeds.
  const upgraded=[];
  try {
    for(const row of labels){
      const embedding=await embed(normalizeText(row.text));
      if(embedding.length!==MODELS[DEFAULTS.model].embeddingDim)throw new Error('Unexpected embedding dimension');
      upgraded.push({...row,embedding});
    }
    await chrome.storage.local.set({[LABELS_KEY]:upgraded,[SETTINGS_KEY]:settings});
    labels=upgraded;
    embeddingUpgradeNeeded=false;
    rebuild();
    status='ready';
  }catch(e){
    status=`Saved ratings are unchanged; embedding upgrade can be retried. ${e.message}`;
    throw new Error(status);
  }
}
function rebuild(){
  if(embeddingUpgradeNeeded){model=null;embeddingDim=0;return;}
  const valid=labels.filter(r=>r && Array.isArray(r.embedding) && r.embedding.length && (r.label===0||r.label===1));
  embeddingDim=valid.length?valid[0].embedding.length:0;
  const matching=valid.filter(r=>r.embedding.length===embeddingDim);
  model=embeddingDim?new BayesianRFF(embeddingDim,{driftStdPerWeek:settings.driftStdPerWeek}).fit(matching):null;
}
function counts(){
  const pos=labels.filter(r=>r.label===1).length;
  const neg=labels.filter(r=>r.label===0).length;
  return {positive:pos,negative:neg,total:pos+neg,ready:!!model?.sufficient()};
}
function remember(key,embedding){
  if(memoryCache.has(key))memoryCache.delete(key);
  memoryCache.set(key,embedding);
  if(memoryCache.size>MAX_CACHE)memoryCache.delete(memoryCache.keys().next().value);
}
async function ensureOffscreen(){
  const url=chrome.runtime.getURL('offscreen.html');
  const existing=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[url]});
  if(existing.length)return;
  if(!creatingDocument)creatingDocument=chrome.offscreen.createDocument({
    url:'offscreen.html', reasons:['WORKERS'],
    justification:'Run a locally bundled ONNX inference runtime in an extension document for text embeddings.'
  }).finally(()=>{creatingDocument=null});
  return creatingDocument;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function embed(text){
  const key=fnv1a(settings.model+'|'+text);
  if(memoryCache.has(key))return memoryCache.get(key);
  if(inference.phase==='idle'||inference.phase==='error')inference={phase:'loading',message:SETUP_MESSAGE};
  try{await ensureOffscreen();}catch(e){
    status=`Error: ${e.message}`;inference={phase:'error',message:e.message};throw e;
  }
  status=`Loading ${MODELS[settings.model].name} or computing an embedding`;
  let result;
  // The offscreen document may still be initializing its JS module.
  for(let attempt=0;attempt<24;attempt++){
    try {
      result=await chrome.runtime.sendMessage({target:'offscreen',type:'EMBED',text,model:settings.model});
      if(!result) throw new Error('Embedding document not ready');
      if(!result.ok)throw new Error(result.error||'Unknown embedding failure');
      break;
    }catch(e){
      if(attempt===23 || !/receiving end|not ready|message port closed/i.test(String(e.message))) {
        status=`Error: ${e.message}`;inference={phase:'error',message:e.message};throw e;
      }
      await sleep(250);
    }
  }
  status='ready';
  inference={phase:'ready',message:'Local model ready.'};
  remember(key,result.embedding);
  return result.embedding;
}
function scoreFromVector(embedding, label=null){
  const c=counts();
  if(!settings.enabled) return {show:true,reason:'paused',probability:null,lower:null,upper:null,...c,label};
  if(!model || !model.sufficient()) return {
    show:label!==0,reason:label===0?'rated-less':label===1?'rated-more':'training',
    probability:null,lower:null,upper:null,...c,label,
  };
  const p=model.predict(embedding);
  const decision=decide(p,settings);
  return {
    show: label===1 ? true : (label===0 ? false : decision.show),
    reason:label===1?'rated-more':label===0?'rated-less':decision.reason,
    probability:p.probability,lower:p.lower,upper:p.upper,
    ...c,label,
  };
}

async function score(text,id){
  const item=labels.find(r=>r.id===id);
  const label=item?.label??null;
  // No need to download a model or embed hundreds of unread posts during cold-start.
  if(!settings.enabled) return {show:true,reason:'paused',probability:null,lower:null,upper:null,...counts(),label};
  if(!model?.sufficient()) return {show:label!==0,reason:label===0?'rated-less':label===1?'rated-more':'training',probability:null,lower:null,upper:null,...counts(),label};
  const embedding=item?.embedding||await embed(text);
  return scoreFromVector(embedding,label);
}

async function labelPost(text,id,label){
  if(label!==0 && label!==1) throw new Error('Invalid rating');
  const embedding=await embed(text);
  const entry={id,label,text,embedding,updatedAt:new Date().toISOString()};
  const index=labels.findIndex(r=>r.id===id);
  if(index>=0)labels[index]=entry;else labels.push(entry);
  await chrome.storage.local.set({[LABELS_KEY]:labels});
  rebuild();
  return scoreFromVector(embedding,label);
}
async function changeSettings(delta){
  const next={...settings};
  if('enabled' in delta)next.enabled=!!delta.enabled;
  if('threshold' in delta) next.threshold=Math.min(.95,Math.max(.05,Number(delta.threshold)||DEFAULTS.threshold));
  if('exploration' in delta)next.exploration=Math.min(.3,Math.max(0,Number(delta.exploration)||0));
  if('driftStdPerWeek' in delta){
    const drift=Number(delta.driftStdPerWeek);
    if(!Number.isFinite(drift)||drift<0||drift>0.5) throw new Error('Drift must be between 0 and 0.5');
    next.driftStdPerWeek=drift;
  }
  if('model' in delta) {
    if(!MODELS[delta.model])throw new Error('Invalid model');
    if(next.model!==delta.model && labels.length)throw new Error('Changing the embedding model requires first exporting and clearing ratings.');
    next.model=delta.model;
  }
  const driftChanged=next.driftStdPerWeek!==settings.driftStdPerWeek;
  settings=next;
  await chrome.storage.local.set({[SETTINGS_KEY]:settings});
  if(driftChanged)rebuild();
  return {settings,counts:counts(),status};
}
async function reset(){
  labels=[];memoryCache.clear();model=null;embeddingDim=0;
  embeddingUpgradeNeeded=false;
  status='idle';
  await chrome.storage.local.set({[LABELS_KEY]:[]});
  return {settings,counts:counts(),status};
}
async function handle(msg){
  await initialize();
  const type=msg.type;
  if(type==='STATUS')return {settings,counts:counts(),status,inference};
  if(type==='SET_SETTINGS')return changeSettings(msg.settings||{});
  if(type==='EXPORT')return {version:1,settings,labels:labels.map(({id,text,label,updatedAt})=>({id,text,label,updatedAt}))};
  if(type==='RESET')return reset();
  if(type==='SCORE' || type==='LABEL'){
    const text=normalizeText(msg.text);
    if(text.length<30)throw new Error('Post text too short');
    await upgradeEmbeddings();
    const id=fnv1a(text); // Stable across refresh; no site identifiers or personal account data.
    const result=type==='SCORE'?await score(text,id):await labelPost(text,id,msg.label);
    return {id,...result};
  }
  throw new Error(`Unknown request: ${type}`);
}
chrome.runtime.onMessage.addListener((msg,_sender,sendResponse)=>{
  if(msg?.target!=='background')return;
  if(msg.type==='MODEL_PROGRESS'){
    if(msg.inference){inference=msg.inference;status=inference.message;}
    else status=msg.detail||'Downloading model';
    sendResponse({ok:true});return;
  }
  if(msg.type==='STATUS'){handle(msg).then(data=>sendResponse({ok:true,...data}),err=>sendResponse({ok:false,error:err.message}));return true;}
  // Serialize message operations, so edits cannot race with scoring/rebuilds.
  opQueue=opQueue.catch(()=>{}).then(()=>handle(msg));
  opQueue.then(data=>sendResponse({ok:true,...data}),err=>sendResponse({ok:false,error:err?.message||String(err)}));
  return true;
});
