import test from 'node:test';import assert from 'node:assert/strict';
import {ARENA_PERSONAS,arenaModelPersona} from '../dist/index.js';
test('six supplied personas map to distinct atlas cells and actual model families',()=>{
 assert.equal(ARENA_PERSONAS.length,6);assert.equal(new Set(ARENA_PERSONAS.map(p=>p.cell)).size,6);
 for(const [modelId,family] of [['deepseek-v4.1-flash','deepseek'],['gemini-3.8-flash','gemini'],['claude-sonnet','claude'],['gpt-6.1-sol','gpt'],['o3-mini','gpt'],['glm-5.3-flash','glm'],['qwen3','qwen']])assert.equal(arenaModelPersona({providerId:'gateway',modelId}),family);
});
test('an arbitrary connection nickname cannot override the selected model family',()=>{
 assert.equal(arenaModelPersona({providerId:'deepseek-proxy',modelId:'gpt-6.1-sol',name:'Claude'}),'gpt');
 assert.equal(arenaModelPersona({providerId:'gateway',modelId:'step-5-preview'}),null);
});
