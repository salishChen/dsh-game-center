import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';import {apply,MemorySaveBackend} from '../staging/index.js';
import {generateArenaBuild,arenaBuildPrompt,arenaReviewTraces} from '../staging/ai/arena-broker.js';
import {ARENA_BUILD_SKILL,quoteArenaPlan} from '@dsh-gamecenter/protocol';
const plan=()=>({body:'classic',bodyLevel:1,mounts:{'wheel-rear':{partId:'roller',level:1},'wheel-front':{partId:'roller',level:1},'weapon-front':{partId:'blade',level:1}}});
function fixture(overrides={}){const calls=[];return {calls,listProviders:async()=>['provider'],listModels:async()=>[{id:'model'}],resolveModelInfo:async()=>({id:'model',reasoning:{efforts:[{id:'high',name:'High'}],defaultEffort:'high'}}),prepareCall:async config=>({config,stream:async function*(options){calls.push(options);yield {type:'reasoning-delta',text:'not a plan'};yield {type:'text-delta',text:JSON.stringify(plan())};yield {type:'usage',usage:{inputTokens:120,outputTokens:30,totalTokens:150}};yield {type:'finish',reason:{kind:'stop'}};}}),...overrides};}
async function setup(t,llm=fixture()){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arena-host-'));await fs.mkdir(path.join(dir,'arena'));await fs.writeFile(path.join(dir,'arena/gamecenter.json'),JSON.stringify({schemaVersion:1,id:'example.cat-arena',name:'鲸械竞技场',version:'0.6.0',ai:{slots:{vehicleBuild:{operation:'chat.generate'}}}}));
  const ctx=new Context();ctx.provide('llm',llm);const api=apply(ctx,{playerId:'arena-test',storageBackend:new MemorySaveBackend(),previewDir:dir});t.after(async()=>{api.dispose();await fs.rm(dir,{recursive:true,force:true});});const service=api.service;
  const hs=service.handshake({runtimeInstanceId:'arena-runtime',gameId:'example.cat-arena',gameVersion:'0.6.0',sdkVersion:'1.0.0',bridgeVersion:1,nonce:'n',saveId:'save-preview',previewId:'arena',launchToken:'launch-0123456789abcdef0123456789abcdef'});assert.equal(hs.ok,true);service.leaseStatus({runtimeToken:hs.runtimeToken});
  const runtimeToken=hs.runtimeToken;await service.setAiBinding({runtimeToken,slot:'vehicleBuild',providerId:'provider',modelId:'model',reasoningEffort:'high'});
  return {service,runtimeToken,llm,hs};
}
test('arena production path freezes route/effort, sends skill+canonical numbers, merges double clicks',async t=>{
  const {service,runtimeToken,llm}=await setup(t);const mode=await service.arenaAction({runtimeToken,action:'mode',mode:'duel',operationId:'enter'});assert.equal(mode.ok,true);
  const request={runtimeToken,slot:'vehicleBuild',operationId:'build-1',input:{roundId:mode.roundId}};
  const [a,b]=await Promise.all([service.aiGenerate(request),service.aiGenerate(request)]);assert.equal(a.ok,true);assert.deepEqual(a,b);assert.equal(llm.calls.length,1);assert.equal(a.binding.reasoningEffort,'high');assert.equal(a.usage.totalTokens,150);quoteArenaPlan(a.output);
  const call=llm.calls[0];assert.equal(call.provider,'provider');assert.equal(call.model,'model');assert.equal(call.reasoningEffort,'high');assert.deepEqual(call.tools,[]);const prompt=call.messages[0].content[0].text;assert.ok(prompt.startsWith(ARENA_BUILD_SKILL));const numbers=JSON.parse(prompt.split('本局规则与实际数值：\n')[1]);assert.equal(numbers.budget,300);assert.equal(numbers.parts.laser.cooldown,2.5);assert.equal('loadout' in numbers,false);assert.equal(numbers.opponentLoadout,'not disclosed');
  assert.equal((await service.aiGenerate({...request,operationId:'second-call'})).ok,false);assert.equal(llm.calls.length,1);
});
test('arena cannot recharge, persist duel state, submit extra budget or replay an earlier round',async t=>{
  const {service,runtimeToken,llm}=await setup(t);const mode=await service.arenaAction({runtimeToken,action:'mode',mode:'duel',operationId:'enter'});
  for(const action of ['exchange','saveGame']){const result=await service.walletAction({runtimeToken,action,amount:1,operationId:action,expectedRevision:0,state:{coins:9999}});assert.equal(result.ok,false);assert.match(result.message,/对战金币/);}
  const request={runtimeToken,slot:'vehicleBuild',operationId:'build-1',input:{roundId:mode.roundId}};
  assert.equal((await service.aiGenerate({...request,input:{...request.input,loadout:plan()}})).ok,false);assert.equal(llm.calls.length,0);
  await service.aiGenerate(request);await service.arenaAction({runtimeToken,action:'reset',operationId:'reset'});assert.equal((await service.aiGenerate(request)).ok,false);assert.equal(llm.calls.length,1);
  await service.arenaAction({runtimeToken,action:'mode',mode:'adventure',operationId:'back'});assert.equal((await service.aiGenerate(request)).ok,false);assert.equal(llm.calls.length,1);
});
test('arena mode change cancels an uncooperative adapter and discards its late response',async t=>{
  let release,signal;const llm=fixture({prepareCall:async(config,s)=>{signal=s;return {config,stream:async function*(){await new Promise(resolve=>release=resolve);yield {type:'text-delta',text:JSON.stringify(plan())};yield {type:'finish',reason:'stop'};}};}});
  const {service,runtimeToken}=await setup(t,llm);const mode=await service.arenaAction({runtimeToken,action:'mode',mode:'duel',operationId:'enter'});
  const pending=service.aiGenerate({runtimeToken,slot:'vehicleBuild',operationId:'build-1',input:{roundId:mode.roundId}});while(!release)await new Promise(r=>setImmediate(r));
  await service.arenaAction({runtimeToken,action:'reset',operationId:'reset'});assert.equal(signal.aborted,true);assert.equal((await pending).ok,false);release();await new Promise(r=>setImmediate(r));
});
test('arena broker rejects overspend, malformed JSON, reasoning-only, abnormal finish and missing finish',async()=>{
  for(const chunks of [[{type:'text-delta',text:JSON.stringify({...plan(),bodyLevel:5,mounts:{...plan().mounts,'weapon-front':{partId:'blade',level:2}}})},{type:'finish',reason:'stop'}],[{type:'text-delta',text:'```json {} ```'},{type:'finish',reason:'stop'}],[{type:'reasoning-delta',text:JSON.stringify(plan())},{type:'finish',reason:'stop'}],[{type:'text-delta',text:JSON.stringify(plan())},{type:'finish',reason:'error'}],[{type:'text-delta',text:JSON.stringify(plan())}]]){
    const llm=fixture({prepareCall:async config=>({config,stream:async function*(){yield*chunks;}})});await assert.rejects(generateArenaBuild(llm,{providerId:'p',modelId:'m'}));
  }
});
test('arena broker enforces the 120 second timeout without waiting for its adapter',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const llm=fixture({prepareCall:async config=>({config,stream:async function*(){await new Promise(()=>{});}})});
  const pending=generateArenaBuild(llm,{providerId:'p',modelId:'m'});t.mock.timers.tick(120000);await assert.rejects(pending,/120 秒/);
});

test('arena prefetch has no human loadout; final lock validates the current human build',async t=>{
 const {service,runtimeToken,llm}=await setup(t);const mode=await service.arenaAction({runtimeToken,action:'mode',mode:'duel',operationId:'enter'});
 assert.equal((await service.arenaAction({runtimeToken,action:'lock',operationId:'early',roundId:mode.roundId,loadout:plan()})).ok,false);
 const result=await service.aiGenerate({runtimeToken,slot:'vehicleBuild',operationId:'prefetch',input:{roundId:mode.roundId}});assert.equal(result.ok,true);assert.equal(llm.calls.length,1);
 const expensive={...plan(),bodyLevel:5,mounts:{...plan().mounts,'weapon-front':{partId:'blade',level:2}}};assert.equal((await service.arenaAction({runtimeToken,action:'lock',operationId:'bad',roundId:mode.roundId,loadout:expensive})).ok,false);
 const edited={...plan(),body:'titan'};assert.equal((await service.arenaAction({runtimeToken,action:'lock',operationId:'lock',roundId:mode.roundId,loadout:edited})).ok,true);
 assert.equal((await service.setAiBinding({runtimeToken,slot:'vehicleBuild',providerId:'provider',modelId:'other',reasoningEffort:'high'})).ok,false);
 assert.equal((await service.arenaAction({runtimeToken,action:'lock',operationId:'change',roundId:mode.roundId,loadout:plan()})).ok,false);
});

test('arena review contains actual prompt, final response, usage and feedback but no reasoning',async t=>{
 const {service,runtimeToken}=await setup(t);const mode=await service.arenaAction({runtimeToken,action:'mode',mode:'duel',operationId:'enter'});
 await service.aiGenerate({runtimeToken,slot:'vehicleBuild',operationId:'prefetch',input:{roundId:mode.roundId}});
 const review=await service.arenaAction({runtimeToken,action:'review',operationId:'review'});assert.equal(review.ok,true);const trace=review.traces[0];assert.equal(trace.status,'succeeded');assert.ok(trace.request.startsWith(ARENA_BUILD_SKILL));assert.equal(JSON.parse(trace.response).body,'classic');assert.equal(trace.usage.totalTokens,150);assert.match(trace.feedback,/30 \/ 300/);assert.equal(trace.response.includes('not a plan'),false);
});

test('arena review preserves invalid model feedback and partial text for diagnosis',async t=>{
 const llm=fixture({prepareCall:async config=>({config,stream:async function*(){yield {type:'text-delta',text:'bad plan <script>no execution</script>'};yield {type:'finish',reason:{kind:'stop'}};}})});
 const {service,runtimeToken}=await setup(t,llm),mode=await service.arenaAction({runtimeToken,action:'mode',mode:'duel',operationId:'enter'});
 assert.equal((await service.aiGenerate({runtimeToken,slot:'vehicleBuild',operationId:'bad-response',input:{roundId:mode.roundId}})).ok,false);
 const review=await service.arenaAction({runtimeToken,action:'review',operationId:'review'});assert.equal(review.traces[0].status,'failed');assert.match(review.traces[0].response,/<script>/);assert.ok(review.traces[0].feedback.length>0);
});

test('arena does not start a model call if navigation pauses during manifest resolution',async t=>{
 const {service,runtimeToken,llm,hs}=await setup(t),mode=await service.arenaAction({runtimeToken,action:'mode',mode:'duel',operationId:'enter'});
 let release,entered;const ready=new Promise(r=>entered=r),original=service.runtimeManifest.bind(service);service.runtimeManifest=async lease=>{entered();await new Promise(r=>release=r);return original(lease);};
 const pending=service.aiGenerate({runtimeToken,slot:'vehicleBuild',operationId:'prefetch',input:{roundId:mode.roundId}});await ready;assert.equal(service.suspendRuntime({runtimeToken,generation:hs.generation}).ok,true);release();assert.equal((await pending).ok,false);assert.equal(llm.calls.length,0);
});

test('arena output cap keeps failure feedback and seals traces against late chunks',async()=>{
 let trace;const llm=fixture({prepareCall:async config=>({config,stream:async function*(){yield {type:'text-delta',text:'a'.repeat(300000)};yield {type:'finish',reason:'stop'};}})});
 await assert.rejects(generateArenaBuild(llm,{providerId:'p',modelId:'m'},undefined,value=>trace={...trace,...value}),/256 KiB/);assert.equal(trace.status,'failed');assert.ok(Buffer.byteLength(trace.response)<256*1024);
});

test('arena review fits the bridge for eight large invalid replies without mutating retained traces',()=>{
 const traces=Array.from({length:8},(_,i)=>({operationId:String(i),status:'failed',binding:{providerId:'provider',modelId:'model'},request:arenaBuildPrompt(),response:'无效回复'.repeat(20000),feedback:'invalid JSON',elapsedMs:1}));
 const view=arenaReviewTraces(traces);assert.ok(Buffer.byteLength(JSON.stringify(view))<=192*1024);assert.ok(view.some(t=>t.responseTruncated));assert.equal(traces[0].response.length,80000);assert.ok(view.every(t=>t.request===arenaBuildPrompt()));
});

test('arena next round retains canonical equipment and sends previous builds/result to the selected model',async t=>{
 const {service,runtimeToken,llm}=await setup(t),mode=await service.arenaAction({runtimeToken,action:'mode',mode:'duel',operationId:'enter'});
 assert.equal((await service.arenaAction({runtimeToken,action:'next',operationId:'too-early',roundId:mode.roundId})).ok,false);
 await service.aiGenerate({runtimeToken,slot:'vehicleBuild',operationId:'first-build',input:{roundId:mode.roundId}});
 const human={...plan(),bodyLevel:2,mounts:{...plan().mounts,'wheel-front':{partId:'bigfoot',level:2}}};assert.equal((await service.arenaAction({runtimeToken,action:'lock',operationId:'lock',roundId:mode.roundId,loadout:human})).ok,true);
 const finish={runtimeToken,action:'finish',operationId:'finish',roundId:mode.roundId,result:{winner:'ai',durationMs:18350}};assert.equal((await service.arenaAction(finish)).ok,true);assert.equal((await service.arenaAction(finish)).ok,true);
 assert.equal((await service.arenaAction({...finish,operationId:'changed-result',result:{winner:'player',durationMs:18350}})).ok,false);
 const command={runtimeToken,action:'next',operationId:'next',roundId:mode.roundId},next=await service.arenaAction(command);assert.equal(next.ok,true);assert.notEqual(next.roundId,mode.roundId);assert.deepEqual(next.retainedPlan,quoteArenaPlan(human).plan);assert.deepEqual(await service.arenaAction(command),next);
 assert.equal((await service.aiGenerate({runtimeToken,slot:'vehicleBuild',operationId:'late-old',input:{roundId:mode.roundId}})).ok,false);
 assert.equal((await service.setAiBinding({runtimeToken,slot:'vehicleBuild',providerId:'provider',modelId:'other-model',reasoningEffort:'high'})).ok,true);const selected=await service.arenaAction({runtimeToken,action:'state',operationId:'selected'});
 await service.aiGenerate({runtimeToken,slot:'vehicleBuild',operationId:'next-build',input:{roundId:selected.roundId}});const numbers=JSON.parse(llm.calls[1].messages[0].content[0].text.split('本局规则与实际数值：\n')[1]);assert.deepEqual(numbers.previousRound.playerPlan,quoteArenaPlan(human).plan);assert.deepEqual(numbers.previousRound.aiPlan,quoteArenaPlan(plan()).plan);assert.deepEqual(numbers.previousRound.result,finish.result);assert.equal(numbers.budget,300);assert.equal('loadout' in numbers,false);
});

test('arena refuses forged results and caller-supplied previous equipment',async t=>{
 const {service,runtimeToken}=await setup(t),mode=await service.arenaAction({runtimeToken,action:'mode',mode:'duel',operationId:'enter'});
 for(const result of [{winner:'player',durationMs:0},{winner:'other',durationMs:20},{winner:'ai',durationMs:47001},{winner:'draw',durationMs:20,playerPlan:plan()}])assert.equal((await service.arenaAction({runtimeToken,action:'finish',operationId:'invalid',roundId:mode.roundId,result})).ok,false);
 assert.equal((await service.arenaAction({runtimeToken,action:'next',operationId:'spoof',roundId:mode.roundId,previousRound:{playerPlan:plan()}})).ok,false);
});
