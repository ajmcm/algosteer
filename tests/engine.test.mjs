import test from 'node:test';
import assert from 'node:assert/strict';
import {BayesianRFF, FeatureMap, decide, fnv1a, sigmoid, cholesky, solveCholesky, DEFAULTS} from '../src/engine.mjs';
const unit=(v)=>{const n=Math.hypot(...v);return v.map(x=>x/n)};
test('feature map deterministic and distinct',()=>{
 const a=new FeatureMap(3), b=new FeatureMap(3);
 assert.deepEqual(Array.from(a.transform(unit([1,0,0]))),Array.from(b.transform(unit([1,0,0]))));
 assert.notDeepEqual(Array.from(a.transform(unit([1,0,0]))),Array.from(a.transform(unit([0,1,0]))));
});
test('Cholesky solve',()=>{
 const L=cholesky(new Float64Array([5,2,2,3]),2);
 const x=solveCholesky(L,new Float64Array([7,8]));
 assert.ok(Math.abs(5*x[0]+2*x[1]-7)<1e-8);
 assert.ok(Math.abs(2*x[0]+3*x[1]-8)<1e-8);
});
test('Bayesian posterior learns and narrows around examples',()=>{
 const model=new BayesianRFF(3,{featureDim:48});
 const yes=unit([1,0,0]),no=unit([0,1,0]);
 const baseline=model.predict(yes);
 model.fit([...Array.from({length:24},(_,i)=>({embedding:yes,label:1})), ...Array.from({length:24},()=>({embedding:no,label:0}))]);
 const positive=model.predict(yes),negative=model.predict(no);
 assert.ok(positive.probability>0.65,JSON.stringify(positive));
 assert.ok(negative.probability<0.35,JSON.stringify(negative));
 assert.ok(positive.logitVariance<baseline.logitVariance);
 assert.equal(model.sufficient(),true);
});
test('no filtering when not enough examples',()=>{
 const model=new BayesianRFF(3);
 model.fit([{embedding:unit([1,0,0]),label:1}]);
 assert.equal(model.sufficient(),false);
});
test('Thompson gate conservatively hides when exploration is disabled',()=>{
 const p={probability:0.1,logitMean:-2,logitVariance:1};
 assert.equal(decide(p,{threshold:0.4,exploration:0}).show,false);
 assert.equal(decide({...p,probability:0.8},{threshold:0.4,exploration:0}).show,true);
});
test('Thompson can explore uncertain low-mean cases',()=>{
 const p={probability:0.2,logitMean:-2,logitVariance:10};
 const seq=[0,Math.exp(-0.5),0];let i=0;
 assert.equal(decide(p,{threshold:0.4,exploration:1},()=>seq[i++%seq.length]).reason,'thompson');
});
test('hash stable and default options sane',()=>{
 assert.equal(fnv1a('abc'),fnv1a('abc'));
 assert.notEqual(fnv1a('abc'),fnv1a('abd'));
 assert.ok(DEFAULTS.exploration>0&&DEFAULTS.exploration<1);
 assert.ok(sigmoid(100)>0.999);
});
