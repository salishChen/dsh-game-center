import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {tokenUsage,summarizeCalls} from '../staging/games/landlord-review.js';
import {Context} from '@deepseek-ai/cordis';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {apply,MemorySaveBackend} from '../staging/index.js';
import {rank,classify,beats,createLandlordGame,applyLandlordAction,landlordSeatView,localLandlordDecision} from '../staging/games/landlord-engine.js';
import {generateLandlordDecision} from '../staging/ai/landlord-broker.js';
const cards=(r,n=1)=>Array.from({length:n},(_,i)=>(r-3)*4+i);
test('deal conserves all 54 cards; bottom cards stay hidden throughout bidding',()=>{
  const state=createLandlordGame();assert.equal(new Set([...state.hands.flat(),...state.bottom]).size,54);
  assert.deepEqual(state.hands.map(h=>h.length),[17,17,17]);
  for(const seat of [0,1,2])assert.deepEqual(landlordSeatView(state,seat).bottomCards,[]);
  applyLandlordAction(state,0,{bid:3});assert.equal(state.landlord,0);assert.equal(state.hands[0].length,20);
  for(const seat of [0,1,2])assert.deepEqual(landlordSeatView(state,seat).bottomCards,state.bottom);
  assert.equal(rank(52),16);assert.equal(rank(53),17);
});
test('supported patterns and comparisons cover bombs, chains, wings and joker restrictions',()=>{
  const examples=[['single',cards(3)],['pair',cards(4,2)],['triple',cards(5,3)],['bomb',cards(6,4)],['rocket',[52,53]],
    ['triple-single',[...cards(7,3),...cards(8)]],['triple-pair',[...cards(7,3),...cards(8,2)]],
    ['straight',[3,4,5,6,7].flatMap(r=>cards(r))],['pair-straight',[3,4,5].flatMap(r=>cards(r,2))],
    ['plane',[3,4].flatMap(r=>cards(r,3))],['plane-single',[...cards(3,3),...cards(4,3),...cards(7,2)]],
    ['plane-pair',[...cards(3,3),...cards(4,3),...cards(7,2),...cards(8,2)]],
    ['four-two-single',[...cards(3,4),...cards(7,2)]],['four-two-pair',[...cards(3,4),...cards(7,2),...cards(8,2)]]];
  for(const [kind,hand]of examples)assert.equal(classify(hand)?.kind,kind,kind);
  assert.equal(classify([11,12,13,14,15].flatMap(r=>cards(r))),null);
  assert.equal(classify([...cards(3,3),...cards(4,3),52,53]),null);
  assert.equal(beats(classify(cards(4,4)),classify(cards(14))),true);
  assert.equal(beats(classify([52,53]),classify(cards(15,4))),true);
  assert.equal(beats(classify(cards(15,4)),classify([52,53])),false);
});
test('illegal plays, wrong turns and leading passes cannot mutate the board',()=>{
  const state=createLandlordGame();applyLandlordAction(state,0,{bid:3});const before=JSON.stringify(state);
  assert.throws(()=>applyLandlordAction(state,1,{cards:[state.hands[1][0]]}));
  assert.throws(()=>applyLandlordAction(state,0,{cards:[state.hands[1][0]]}));
  assert.throws(()=>applyLandlordAction(state,0,{cards:[]}));assert.equal(JSON.stringify(state),before);
  const own=state.hands[0][0];applyLandlordAction(state,0,{cards:[own]});applyLandlordAction(state,1,{cards:[]});applyLandlordAction(state,2,{cards:[]});
  assert.equal(state.turn,0);assert.equal(state.last,null);
});
test('local strategies complete 30 full deals with only legal seat-view decisions',()=>{
  for(let n=0;n<30;n++){const state=createLandlordGame();applyLandlordAction(state,0,{bid:3});let turns=0;
    while(state.phase!=='finished'&&turns++<500){const view=landlordSeatView(state,state.turn);applyLandlordAction(state,state.turn,localLandlordDecision(view));}
    assert.equal(state.phase,'finished');assert.ok(state.winner!==null);assert.equal(state.hands[state.winner].length,0);
    assert.equal(new Set([...state.hands.flat(),...state.history.flatMap(p=>p.cards)]).size,54);
  }
});
test('swapping opponents hidden hands cannot alter current seat AI view or local policy',()=>{
  const original=createLandlordGame();applyLandlordAction(original,0,{bid:3});applyLandlordAction(original,0,{cards:[original.hands[0][0]]});
  const changed=structuredClone(original);
  // Keep seat 1 fixed; redistribute only still-hidden cards of seats 0 and 2.
  [changed.hands[0][0],changed.hands[2][0]]=[changed.hands[2][0],changed.hands[0][0]];
  const a=landlordSeatView(original,1),b=landlordSeatView(changed,1);
  assert.deepEqual(a,b);assert.deepEqual(localLandlordDecision(a),localLandlordDecision(b));
  assert.equal('hands' in a,false);assert.equal('deck' in a,false);assert.equal('seed' in a,false);
});
function fixture(behavior){const calls=[];return {calls,listProviders:async()=>['test-provider'],listModels:async()=>[{id:'seat-model'}],resolveModelInfo:async()=>({reasoning:{efforts:[{id:'high',name:'High'},{id:'low',name:'Low'}],defaultEffort:'low'}}),prepareCall:async config=>({config,stream:async function*(request){calls.push(request);if(behavior){yield* behavior(request);return;}const view=JSON.parse(request.messages[0].content[0].text.split('\n').at(-1));yield {type:'reasoning-delta',text:'private reasoning never returned'};yield {type:'text-delta',text:JSON.stringify(view.phase==='bidding'?{bid:0}:{moveId:0})};yield {type:'usage',usage:{inputTokens:10,outputTokens:2,cacheReadTokens:3,totalTokens:15}};yield {type:'finish',reason:{kind:'stop'}};}})};}
test('broker prompts are seat-isolated, stateless, tool-free and exclude undeclared/hidden state',async()=>{
  const state=createLandlordGame();applyLandlordAction(state,0,{bid:0});const llm=fixture();await generateLandlordDecision(llm,{providerId:'p',modelId:'seat1',reasoningEffort:'high'},landlordSeatView(state,1));
  const request=llm.calls[0],payload=JSON.parse(request.messages[0].content[0].text.split('\n').at(-1));
  assert.deepEqual(request.tools,[]);assert.equal(request.messages.length,1);assert.deepEqual(payload.ownHand,state.hands[1]);assert.deepEqual(payload.bottomCards,[]);
  assert.equal(payload.hands,undefined);assert.equal(payload.deck,undefined);assert.equal(payload.rngState,undefined);assert.equal(payload.seed,undefined);assert.equal(request.reasoningEffort,'high');assert.match(request.messages[0].content[0].text,/within 5 seconds of receiving this message/);
  const changed=structuredClone(state);[changed.hands[0][0],changed.hands[2][0]]=[changed.hands[2][0],changed.hands[0][0]];
  await generateLandlordDecision(llm,{providerId:'p',modelId:'seat1',reasoningEffort:'high'},landlordSeatView(changed,1));
  assert.equal(llm.calls[0].messages[0].content[0].text,llm.calls[1].messages[0].content[0].text);
});
async function serviceFixture(t,llm=fixture(),gameId='example.landlord'){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gc-landlord-'));await fs.mkdir(path.join(dir,'table'));
  await fs.writeFile(path.join(dir,'table','gamecenter.json'),JSON.stringify({schemaVersion:1,id:gameId,ai:{slots:{landlordSeat1:{operation:'chat.generate'},landlordSeat2:{operation:'chat.generate'},boardGeneration:{operation:'chat.generate'}}}}));
  const ctx=new Context();ctx.provide('llm',llm);const api=apply(ctx,{playerId:'landlord-test',storageBackend:new MemorySaveBackend(),previewDir:dir});t.after(()=>api.dispose());t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const hs=api.service.handshake({runtimeInstanceId:'landlord-runtime',gameId,gameVersion:'0.1.0',sdkVersion:'1.0.0',bridgeVersion:1,nonce:'n',saveId:'save-preview',previewId:'table',launchToken:'landlord-0123456789abcdef0123456789abcdef'});assert.equal(hs.ok,true);api.service.leaseStatus({runtimeToken:hs.runtimeToken});
  let seq=0;return {service:api.service,hs,llm,command:async(action,view,extra={})=>api.service.landlordAction({runtimeToken:hs.runtimeToken,operationId:`step-${++seq}`,action,...(view?{expectedRevision:view.revision}:{}),...extra})};
}
test('Host owns deal, validates human commands, isolates seat binding and merges repeated AI turns',async t=>{
  const {service,hs,llm,command}=await serviceFixture(t);let res=await command('state');const first=res.view;
  assert.equal(first.ownHand.length,17);assert.equal(first.hands,undefined);assert.deepEqual(first.bottomCards,[]);
  const bypass=await service.aiGenerate({runtimeToken:hs.runtimeToken,slot:'landlordSeat1',operationId:'bypass',input:{hands:[[1],[2],[3]],prompt:'leak'}});
  assert.equal(bypass.ok,false);assert.equal(llm.calls.length,0,'generic AI cannot bypass the Host seat view');
  assert.equal((await command('bid',first,{bid:4})).ok,false);
  assert.equal((await command('state',null,{hands:[[1]],prompt:'leak',seat:2})).ok,false);
  res=await command('bid',first,{bid:0});assert.equal(res.view.turn,1);
  assert.equal((await command('play',res.view,{cards:[1]})).ok,false);
  assert.equal((await service.setAiBinding({runtimeToken:hs.runtimeToken,slot:'landlordSeat1',providerId:'test-provider',modelId:'model-1',reasoningEffort:'fake'})).ok,false);
  assert.equal(llm.calls.length,0);
  assert.equal((await service.setAiBinding({runtimeToken:hs.runtimeToken,slot:'landlordSeat1',providerId:'test-provider',modelId:'model-1',reasoningEffort:'high'})).ok,true);
  assert.equal((await command('review',res.view)).ok,false,'review is forbidden before the game ends');
  const input={runtimeToken:hs.runtimeToken,operationId:'ai-once',action:'ai',expectedRevision:res.view.revision};
  const [a,b]=await Promise.all([service.landlordAction(input),service.landlordAction(input)]);
  assert.deepEqual(a,b);assert.equal(a.ok,true);assert.equal(a.decision.source,'ai');assert.equal(a.decision.binding.modelId,'model-1');assert.equal(a.decision.binding.reasoningEffort,'high');assert.equal(llm.calls.length,1);
  assert.deepEqual(await service.landlordAction(input),a);assert.equal(llm.calls.length,1);
  assert.equal(JSON.stringify(a).includes('ownHand',JSON.stringify(a).indexOf('decision')),false);assert.equal(a.review,undefined);assert.equal(a.prompt,undefined);
  assert.equal(a.view.seat,0);assert.equal(a.view.hands,undefined);
  const next=await command('ai',a.view);assert.equal(next.ok,true);assert.equal(next.decision.seat,2);assert.equal(next.decision.source,'local','unbound other seat does not inherit model 1');
});
test('illegal model output falls back honestly to a legal local move',async t=>{
  const llm=fixture(async function*(){yield {type:'text-delta',text:'{"bid":999}'};yield {type:'finish',reason:{kind:'stop'}};});
  const {service,hs,command}=await serviceFixture(t,llm);const initial=await command('state');const after=await command('bid',initial.view,{bid:0});
  await service.setAiBinding({runtimeToken:hs.runtimeToken,slot:'landlordSeat1',providerId:'p',modelId:'m'});
  const result=await command('ai',after.view);assert.equal(result.ok,true);assert.equal(result.decision.source,'local');assert.match(result.decision.reason,/不合法/);
});
test('suspend cancels a pending model turn; late output cannot mutate the game or trigger fallback',async t=>{
  let release;const gate=new Promise(r=>{release=r;});let entered;const started=new Promise(r=>{entered=r;});
  const llm=fixture(async function*(){entered();await gate;yield {type:'text-delta',text:'{"bid":0}'};yield {type:'finish',reason:{kind:'stop'}};});
  const {service,hs,command}=await serviceFixture(t,llm);const initial=await command('state');const after=await command('bid',initial.view,{bid:0});await service.setAiBinding({runtimeToken:hs.runtimeToken,slot:'landlordSeat1',providerId:'p',modelId:'m'});
  const pending=command('ai',after.view);await started;assert.equal(service.suspendRuntime({runtimeToken:hs.runtimeToken,generation:hs.generation}).ok,true);
  const cancelled=await pending;assert.equal(cancelled.ok,false);release();service.resumeRuntime({runtimeToken:hs.runtimeToken,generation:hs.generation});
  const state=await command('state');assert.equal(state.view.revision,after.view.revision);assert.equal(state.view.turn,1);
});
test('Minesweeper AI is rejected by Host even for a legacy manifest declaring an AI slot',async t=>{
  const {service,hs,llm}=await serviceFixture(t,fixture(),'example.minesweeping');
  assert.equal((await service.setAiBinding({runtimeToken:hs.runtimeToken,slot:'boardGeneration',providerId:'p',modelId:'m'})).ok,false);
  const result=await service.aiGenerate({runtimeToken:hs.runtimeToken,slot:'boardGeneration',operationId:'old-ai',input:{}});assert.equal(result.ok,false);assert.match(result.message,/取消/);assert.equal(llm.calls.length,0);
});

test('two separately-bound model seats finish a complete Host-authoritative deal with legal private views',async t=>{
  const {service,hs,llm,command}=await serviceFixture(t);for(const seat of [1,2])assert.equal((await service.setAiBinding({runtimeToken:hs.runtimeToken,slot:`landlordSeat${seat}`,providerId:'p',modelId:`model-${seat}`,reasoningEffort:seat===1?'high':'low'})).ok,true);
  let result=await command('state');result=await command('bid',result.view,{bid:3});let turns=0;
  while(result.view.phase!=='finished'&&turns++<500){
    if(result.view.turn===0){const move=localLandlordDecision(result.view);result=await command('play',result.view,{cards:move.cards});}
    else result=await command('ai',result.view);
    assert.equal(result.ok,true,result.message);
  }
  assert.equal(result.view.phase,'finished');assert.ok(llm.calls.length>1);
  const reviewResult=await command('review',result.view);assert.equal(reviewResult.ok,true);
  const review=reviewResult.review;assert.equal(review.calls.length,llm.calls.length);assert.equal(review.summary.modelCalls,llm.calls.length);
  assert.equal(review.summary.totals.totalTokens,llm.calls.length*15);assert.equal(review.summary.reportedCalls.totalTokens,llm.calls.length);
  assert.equal(JSON.stringify(review).includes('private reasoning never returned'),false);
  for(let i=0;i<review.calls.length;i++){const c=review.calls[i],request=llm.calls[i];assert.equal(c.prompt,request.messages[0].content[0].text);assert.equal(c.source,'ai');assert.equal(c.status,'success');assert.equal(c.binding.modelId,`model-${c.seat}`);assert.equal(c.response,'{"moveId":0}');assert.equal(JSON.parse(c.prompt.split('\n').at(-1)).seat,c.seat);}
  const oldRevision=result.view.revision;const fresh=await command('new',result.view);assert.equal(fresh.ok,true);assert.equal((await command('review',fresh.view)).ok,false);
  assert.equal((await command('review',{revision:oldRevision},{operationId:'review-old'})).ok,false);
  assert.equal(JSON.stringify(await command('state')).includes('prompt'),false);

  for(const call of llm.calls){const view=JSON.parse(call.messages[0].content[0].text.split('\n').at(-1));assert.equal(call.model,`model-${view.seat}`);assert.equal(call.reasoningEffort,view.seat===1?'high':'low');assert.ok(view.ownHand.length<=20);assert.equal(view.hands,undefined);assert.equal(view.seat===1||view.seat===2,true);}
});

test('manual cancel and redeal abort in-flight turns and never apply old-round decisions',async t=>{
  let entered;const started=new Promise(r=>{entered=r;});const llm=fixture(async function*(){entered();await new Promise(()=>{});});
  const {service,hs,command}=await serviceFixture(t,llm);const initial=await command('state');const after=await command('bid',initial.view,{bid:0});await service.setAiBinding({runtimeToken:hs.runtimeToken,slot:'landlordSeat1',providerId:'p',modelId:'m'});
  const pending=command('ai',after.view);await started;
  assert.equal((await service.abandonRuntime({runtimeInstanceId:'landlord-runtime',launchToken:'wrong-token-0123456789abcdef0123456789abcdef'})).ok,false);
  assert.equal((await service.setAiBinding({runtimeToken:hs.runtimeToken,slot:'landlordSeat1',providerId:'p',modelId:'m'})).errorCode,'RATE_LIMIT','unmatched abandon cannot cancel another session');
  const cancel=await command('cancel');assert.equal(cancel.ok,true);assert.equal((await pending).ok,false);
  const fresh=await command('new',cancel.view);assert.equal(fresh.ok,true);assert.equal(fresh.view.turn,0);assert.equal(fresh.view.phase,'bidding');assert.equal(fresh.view.revision,after.view.revision+1);
});


test('usage normalization preserves reported totals, zero and cache counters without inferring missing usage',()=>{
  assert.deepEqual(tokenUsage({inputTokens:10,outputTokens:2,totalTokens:15,cacheReadTokens:3,reasoningTokens:1,apiKey:'secret',negative:-1}),{inputTokens:10,outputTokens:2,totalTokens:15,cacheReadTokens:3,reasoningTokens:1});
  assert.deepEqual(tokenUsage({inputTokens:-1,outputTokens:NaN,totalTokens:1.5,cacheReadTokens:0,cacheWriteTokens:Infinity}),{cacheReadTokens:0});
  const base={operationId:'a',seat:1,revision:1,startedAt:'now',elapsedMs:0,status:'success',source:'ai',requestedBinding:{providerId:'p',modelId:'m'}};
  const summary=summarizeCalls([{...base,usage:{inputTokens:10,outputTokens:2,totalTokens:15,cacheReadTokens:3}}, {...base,operationId:'b',usage:{}},{...base,operationId:'c',status:'failed',source:'local',usage:{totalTokens:0}}]);
  assert.equal(summary.modelCalls,3);assert.equal(summary.totals.totalTokens,15);assert.equal(summary.reportedCalls.totalTokens,2);assert.equal(summary.localDecisions,1);
});

test('broker audits failed JSON and stream failures with actual usage, excluding internal reasoning',async()=>{
  const state=createLandlordGame();applyLandlordAction(state,0,{bid:0});
  for(const mode of ['invalid','failed']){
    let report;
    const llm=fixture(async function*(){yield {type:'reasoning-delta',text:'SECRET THINKING'};yield {type:'usage',usage:{inputTokens:10,totalTokens:10,authorization:'secret'}};yield {type:'text-delta',text:'{"bid":999}'};yield {type:'usage',usage:{outputTokens:2,totalTokens:12}};yield {type:'finish',reason:{kind:mode==='failed'?'failed':'stop'}};});
    await assert.rejects(generateLandlordDecision(llm,{providerId:'p',modelId:'m'},landlordSeatView(state,1),undefined,r=>report=r));
    assert.equal(report.status,'failed');assert.equal(report.usage.totalTokens,12);assert.equal(report.usage.inputTokens,10);assert.equal(report.usage.outputTokens,2);assert.equal(report.response,'{"bid":999}');
    assert.equal(JSON.stringify(report).includes('SECRET THINKING'),false);assert.equal(JSON.stringify(report).includes('authorization'),false);
  }
});

test('broker seals cancelled trace snapshots against late adapter output and usage',async()=>{
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let report,reports=0;
  const llm=fixture(async function*(){yield {type:'usage',usage:{inputTokens:7,totalTokens:7}};entered();await gate;yield {type:'usage',usage:{totalTokens:999}};yield {type:'text-delta',text:'{"bid":0}'};yield {type:'finish',reason:{kind:'stop'}};});
  const state=createLandlordGame();applyLandlordAction(state,0,{bid:0});const controller=new AbortController();
  const result=generateLandlordDecision(llm,{providerId:'p',modelId:'m'},landlordSeatView(state,1),controller.signal,r=>{report=r;reports++;});
  await started;controller.abort();await assert.rejects(result);const frozen=JSON.stringify(report);release();await new Promise(r=>setImmediate(r));
  assert.equal(report.status,'cancelled');assert.equal(report.usage.totalTokens,7);assert.equal(reports,1);assert.equal(JSON.stringify(report),frozen);
});

test('failed model calls are counted once in postgame review and a new game clears previous traces',async t=>{
  const llm=fixture(async function*(){yield {type:'usage',usage:{inputTokens:8,outputTokens:1,totalTokens:9}};yield {type:'text-delta',text:'{"bid":999}'};yield {type:'finish',reason:{kind:'stop'}};});
  const {service,hs,command}=await serviceFixture(t,llm);for(const seat of [1,2])await service.setAiBinding({runtimeToken:hs.runtimeToken,slot:`landlordSeat${seat}`,providerId:'p',modelId:'bad'});
  let result=await command('state');result=await command('bid',result.view,{bid:3});
  const finish=async()=>{for(let i=0;result.view.phase!=='finished'&&i<500;i++){if(result.view.turn===0)result=await command('play',result.view,{cards:localLandlordDecision(result.view).cards});else{const op={operationId:'once-'+result.view.revision};const [a,b]=await Promise.all([command('ai',result.view,op),command('ai',result.view,op)]);assert.deepEqual(a,b);result=a;}assert.equal(result.ok,true,result.message);}assert.equal(result.view.phase,'finished');};
  await finish();const old=await command('review',result.view);assert.equal(old.ok,true);assert.equal(old.review.summary.modelCalls,llm.calls.length);assert.equal(old.review.summary.totals.totalTokens,llm.calls.length*9);
  assert.ok(old.review.calls.every(c=>c.status==='failed'&&c.source==='local'&&c.action&&c.response==='{"bid":999}'));
  old.review.calls[0].prompt='tampered';assert.notEqual((await command('review',result.view)).review.calls[0].prompt,'tampered','review returns copies');
  result=await command('new',result.view);assert.equal((await command('review',result.view)).ok,false);
  for(const seat of [1,2])service.aiBindings.delete(`landlord-runtime landlordSeat${seat}`); // JS test seam: no model calls in next round.
  result=await command('bid',result.view,{bid:3});await finish();const fresh=await command('review',result.view);assert.equal(fresh.review.summary.modelCalls,0);assert.ok(fresh.review.calls.every(c=>c.status==='local'&&!c.prompt));
});

test('remaining-card counter derives only ranks outside own hand and public plays, including jokers and revealed bottom',async()=>{
  const sandbox={};vm.runInNewContext(await fs.readFile(new URL('../../../games/doudizhu/src/insights.js',import.meta.url),'utf8'),sandbox);
  const {remainingRanks}=sandbox.LandlordInsights;
  const view={ownHand:[0,4,52],history:[{seat:0,cards:[1]},{seat:2,cards:[2,53]}],bottomCards:[0,2,4]};
  const byRank=Object.fromEntries(remainingRanks(view).map(x=>[x.rank,x.count]));
  assert.equal(byRank[3],1);assert.equal(byRank[4],3);assert.equal(byRank[16],0);assert.equal(byRank[17],0);assert.equal(Object.values(byRank).reduce((a,b)=>a+b),48);
  const swapped={...view,hands:[[0],[3],[5]],bottomCards:[5,6,7]};assert.equal(JSON.stringify(remainingRanks(swapped)),JSON.stringify(remainingRanks(view)));
  const all={ownHand:Array.from({length:54},(_,i)=>i),history:[]};assert.ok(remainingRanks(all).every(x=>x.count===0));
});
