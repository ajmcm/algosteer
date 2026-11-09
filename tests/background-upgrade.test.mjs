import test from 'node:test';
import assert from 'node:assert/strict';
import {BayesianRFF,FEATURE_DIM,fnv1a} from '../src/engine.mjs';

test('512-feature startup reuses old stored embeddings without writing history or settings',async(t)=>{
 const labels=Array.from({length:16},(_,i)=>{
  const text=`Previously rated post number ${i}: enough text to score from saved embeddings.`;
  return {id:fnv1a(text),text,label:i%2,embedding:Array.from({length:768},(_,j)=>j===i%2?1:0),updatedAt:new Date(Date.UTC(2026,0,1,0,i)).toISOString()};
 });
 const settings={model:'gemma',enabled:true,threshold:.41,exploration:.08,driftStdPerWeek:.12};
 const stored={'labels-v1':labels,'settings-v1':settings},before=structuredClone(stored);
 // Stored records are dimension-independent; the old model used these same records.
 const old=new BayesianRFF(768,{featureDim:64}).fit(labels);
 assert.equal(old.d,65);
 let listener,writes=0;const fitted=[];
 const oldFit=BayesianRFF.prototype.fit,previousChrome=globalThis.chrome;
 BayesianRFF.prototype.fit=function(samples,...args){
  fitted.push({dimension:this.d,samples:structuredClone(samples)});
  return oldFit.call(this,samples,...args);
 };
 t.after(()=>{BayesianRFF.prototype.fit=oldFit;if(previousChrome===undefined)delete globalThis.chrome;else globalThis.chrome=previousChrome;});
 globalThis.chrome={storage:{local:{get:async keys=>{assert.deepEqual(keys,['settings-v1','labels-v1']);return structuredClone(stored);},set:async()=>{writes++;throw Error('Upgrade must not write storage');}}},runtime:{onMessage:{addListener:fn=>{listener=fn;}}}};
 await import('../src/background.js?upgrade-test');
 const request=msg=>new Promise(resolve=>assert.equal(listener({target:'background',...msg},{},resolve),true));
 const status=await request({type:'STATUS'});
 assert.equal(status.ok,true);assert.deepEqual(status.settings,settings);
 assert.deepEqual(status.counts,{positive:8,negative:8,total:16,ready:true});
 assert.equal(FEATURE_DIM,512);assert.equal(fitted.length,1);assert.equal(fitted[0].dimension,513);assert.deepEqual(fitted[0].samples,labels);
 const score=await request({type:'SCORE',text:labels[1].text});
 assert.equal(score.ok,true);assert.equal(score.label,1);assert.equal(score.reason,'rated-more');assert.equal(score.show,true);assert.ok(Number.isFinite(score.probability));
 const exported=await request({type:'EXPORT'});
 assert.deepEqual(exported.labels,labels.map(({embedding,...row})=>row));
 assert.equal(writes,0);assert.deepEqual(stored,before);
});


test('removed encoder upgrades saved ratings atomically and retries failed inference',async(t)=>{
 const labels=Array.from({length:2},(_,i)=>{
  const text=`An older saved post ${i} with enough text for an explicit rating.`;
  return {id:fnv1a(text),text,label:i,embedding:Array.from({length:384},(_,j)=>j===i?1:0),updatedAt:`2026-01-01T00:0${i}:00.000Z`};
 });
 const original={'labels-v1':labels,'settings-v1':{model:'mini',enabled:true,threshold:.41,exploration:.08,driftStdPerWeek:.12}};
 let saved=structuredClone(original),listener,writes=0,attempts=0,fail=true;
 const previousChrome=globalThis.chrome;
 t.after(()=>{if(previousChrome===undefined)delete globalThis.chrome;else globalThis.chrome=previousChrome;});
 globalThis.chrome={
  storage:{local:{get:async()=>structuredClone(saved),set:async values=>{writes++;saved={...saved,...structuredClone(values)};}}},
  runtime:{getURL:path=>`chrome-extension://test/${path}`,getContexts:async()=>[{}],onMessage:{addListener:fn=>{listener=fn;}},sendMessage:async msg=>{
   assert.equal(msg.type,'EMBED');assert.equal(msg.model,'gemma');attempts++;
   if(fail && attempts===2)return {ok:false,error:'GPU unavailable'};
   return {ok:true,embedding:Array.from({length:768},(_,j)=>j===0?1:0)};
  }}
 };
 await import('../src/background.js?encoder-upgrade-test');
 const request=msg=>new Promise(resolve=>assert.equal(listener({target:'background',...msg},{},resolve),true));
 const initial=await request({type:'STATUS'});assert.equal(initial.settings.model,'gemma');assert.equal(initial.counts.total,2);assert.equal(writes,0);
 const failed=await request({type:'SCORE',text:labels[0].text});assert.equal(failed.ok,false);assert.match(failed.error,/unchanged/);assert.equal(writes,0);assert.deepEqual(saved,original);
 const exported=await request({type:'EXPORT'});assert.equal(exported.labels.length,2);
 fail=false;
 const success=await request({type:'SCORE',text:labels[0].text});assert.equal(success.ok,true);assert.equal(success.label,0);assert.equal(writes,1);assert.equal(saved['settings-v1'].model,'gemma');
 assert.deepEqual(saved['labels-v1'].map(({embedding,...row})=>row),labels.map(({embedding,...row})=>row));
 assert.ok(saved['labels-v1'].every(row=>row.embedding.length===768));
 const rejected=await request({type:'SET_SETTINGS',settings:{model:'mini'}});assert.equal(rejected.ok,false);assert.equal(writes,1);
});

test('new installation uses the sole supported encoder',async(t)=>{
 let listener;const previousChrome=globalThis.chrome;
 t.after(()=>{if(previousChrome===undefined)delete globalThis.chrome;else globalThis.chrome=previousChrome;});
 globalThis.chrome={storage:{local:{get:async()=>({}),set:async()=>{throw Error('No settings write needed');}}},runtime:{onMessage:{addListener:fn=>{listener=fn;}}}};
 await import('../src/background.js?fresh-encoder-test');
 const result=await new Promise(resolve=>listener({target:'background',type:'STATUS'},{},resolve));
 assert.equal(result.ok,true);assert.equal(result.settings.model,'gemma');assert.equal(result.counts.total,0);
});
