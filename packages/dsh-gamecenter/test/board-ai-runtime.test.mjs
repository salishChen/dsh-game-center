import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {apply, MemorySaveBackend} from '../staging/index.js';
import {generateBoard} from '../staging/ai/board-broker.js';

const matrix = {rows:2,cols:2,matrix:[[1,0],[0,0]]};
const input = {rows:2,cols:2,mineCount:1,firstClick:{row:1,col:1}};
function llmFixture(overrides={}) {
  const calls=[];
  return {calls, listProviders:async()=>['provider'], listModels:async()=>[{id:'model'}],
    resolveModelInfo:async()=>({id:'model',reasoning:{efforts:[{id:'high',name:'High'}],defaultEffort:'high'}}),
    prepareCall:async config=>({config,stream:async function*(options){calls.push(options);yield {type:'reasoning-delta',text:'ignore me'};yield {type:'text-delta',text:JSON.stringify(matrix)};yield {type:'usage',usage:{inputTokens:10,outputTokens:20}};yield {type:'finish',reason:{kind:'stop'}};}}),
    ...overrides};
}
test('production apply dispatches actual selected route/effort, replays once and pauses past TTL', async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gc-ai-production-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'sample'));
  await fs.writeFile(path.join(dir,'sample','gamecenter.json'),JSON.stringify({schemaVersion:1,id:'example.matrix',version:'1.0.0',ai:{slots:{boardGeneration:{operation:'chat.generate'}}}}));
  const llm=llmFixture();const ctx=new Context();ctx.provide('llm',llm);
  let now=1000;
  const api=apply(ctx,{playerId:'p',storageBackend:new MemorySaveBackend(),previewDir:dir,nowMs:()=>now});
  t.after(()=>api.dispose());
  const service=api.service;
  const hs=service.handshake({runtimeInstanceId:'matrix-runtime',gameId:'example.matrix',gameVersion:'1.0.0',sdkVersion:'1.0.0',bridgeVersion:1,nonce:'n',saveId:'save-preview',previewId:'sample',launchToken:'launch-0123456789abcdef0123456789abcdef'});
  assert.equal(hs.ok,true);
  service.leaseStatus({runtimeToken:hs.runtimeToken});
  const invalid=await service.setAiBinding({runtimeToken:hs.runtimeToken,slot:'boardGeneration',providerId:'provider',modelId:'model',reasoningEffort:'fake'});
  assert.equal(invalid.ok,false);assert.equal(llm.calls.length,0);
  const bound=await service.setAiBinding({runtimeToken:hs.runtimeToken,slot:'boardGeneration',providerId:'provider',modelId:'model',reasoningEffort:'high'});
  assert.equal(bound.ok,true);
  const request={runtimeToken:hs.runtimeToken,slot:'boardGeneration',operationId:'board-1',input};
  const [result,replayed]=await Promise.all([service.aiGenerate(request),service.aiGenerate(request)]);
  assert.equal(result.ok,true);assert.deepEqual(result.output,matrix);assert.deepEqual(result,replayed);
  assert.equal(result.binding.reasoningEffort,'high');assert.equal(llm.calls.length,1);
  assert.equal(llm.calls[0].provider,'provider');assert.equal(llm.calls[0].model,'model');assert.equal(llm.calls[0].reasoningEffort,'high');
  assert.equal(llm.calls[0].tools,undefined);assert.match(llm.calls[0].messages[0].content[0].text,/matrix/);
  assert.equal((await service.aiGenerate(request)).binding.reasoningEffort,'high');assert.equal(llm.calls.length,1);
  const ctl={runtimeToken:hs.runtimeToken,generation:hs.generation};
  assert.equal(service.suspendRuntime(ctl).ok,true);now+=200_000;
  assert.equal((await service.aiGenerate({...request,operationId:'hidden'})).ok,false);
  assert.equal(service.resumeRuntime(ctl).ok,true);
  assert.equal((await service.saveLatest({gameId:'example.matrix',saveId:'save-preview'})).errorCode,'SAVE_UNSUPPORTED');
  assert.equal((await service.abandonRuntime({runtimeInstanceId:'matrix-runtime',launchToken:'launch-0123456789abcdef0123456789abcdef'})).ok,true);
  assert.equal(service.resumeRuntime(ctl).ok,false);
});
test('broker rejects terminal failures, truncated streams and reasoning-only output', async()=>{
  for (const chunks of [
    [{type:'text-delta',text:JSON.stringify(matrix)},{type:'finish',reason:{kind:'error',failure:{message:'network'}}}],
    [{type:'text-delta',text:JSON.stringify(matrix)}],
    [{type:'reasoning-delta',text:JSON.stringify(matrix)},{type:'finish',reason:{kind:'stop'}}],
    [{type:'text-delta',text:'x'.repeat(256*1024+1)}],
  ]) {
    const llm=llmFixture({prepareCall:async config=>({config,stream:async function*(){yield* chunks;}})});
    await assert.rejects(generateBoard(llm,{providerId:'p',modelId:'m'},'boardGeneration',input));
  }
});
test('broker forwards AbortSignal and does not wait on an uncooperative adapter', async()=>{
  const controller=new AbortController();let received;
  const llm=llmFixture({prepareCall:async(config,signal)=>{received=signal;return {config,stream:async function*(){await new Promise(()=>{});}}}});
  const promise=generateBoard(llm,{providerId:'p',modelId:'m'},'boardGeneration',input,controller.signal);
  controller.abort();await assert.rejects(promise,{name:'AbortError'});assert.equal(received.aborted,true);
});
