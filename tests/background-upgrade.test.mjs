import test from 'node:test';
import assert from 'node:assert/strict';
import {BayesianRFF,FEATURE_DIM,fnv1a} from '../src/engine.mjs';

test('512-feature startup reuses old stored embeddings without writing history or settings',async(t)=>{
 const labels=Array.from({length:16},(_,i)=>{
  const text=`Previously rated post number ${i}: enough text to score from saved embeddings.`;
  return {id:fnv1a(text),text,label:i%2,embedding:i%2?[1,0,0]:[0,1,0],updatedAt:new Date(Date.UTC(2026,0,1,0,i)).toISOString()};
 });
 const settings={model:'gemma',enabled:true,threshold:.41,exploration:.08,driftStdPerWeek:.12};
 const stored={'labels-v1':labels,'settings-v1':settings},before=structuredClone(stored);
 // Stored records are dimension-independent; the old model used these same records.
 const old=new BayesianRFF(3,{featureDim:64}).fit(labels);
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
