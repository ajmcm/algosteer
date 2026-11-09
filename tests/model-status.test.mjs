import test from 'node:test';
import assert from 'node:assert/strict';
import {createDownloadReporter,activeInferenceMessage,SETUP_MESSAGE} from '../src/model-status.mjs';

test('multi-asset progress never claims file completion means model ready',()=>{
 const events=[],report=createDownloadReporter(e=>events.push(e));
 report({status:'initiate',file:'config.json'});
 report({status:'progress',file:'config.json',progress:100});
 report({status:'done',file:'config.json'});
 report({status:'progress',file:'weights.onnx',progress:23});
 assert.equal(events[1].progress,100);assert.match(events[1].message,/current file/);
 assert.equal(events[2].phase,'preparing');assert.equal(events[3].phase,'downloading');assert.equal(events[3].progress,20);
 assert.ok(events.every(e=>e.phase!=='ready'));
 const count=events.length;report({status:'progress',file:'weights.onnx',progress:24});assert.equal(events.length,count);
 report({status:'ready'});assert.equal(events.length,count);
});

test('first use, warm inference and failure have different messages',()=>{
 assert.equal(activeInferenceMessage({phase:'idle',message:''}),SETUP_MESSAGE);
 assert.match(SETUP_MESSAGE,/175 MB/);assert.match(SETUP_MESSAGE,/few minutes/);assert.match(SETUP_MESSAGE,/WebGPU/);
 assert.equal(activeInferenceMessage({phase:'ready',message:'Local model ready.'}),'Processing post locally…');
 assert.equal(activeInferenceMessage({phase:'error',message:'WebGPU unavailable'}),'WebGPU unavailable');
});
