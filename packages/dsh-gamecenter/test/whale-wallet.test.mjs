import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {WhaleWallet,attachWhaleMeter,hasWhaleWallet} from '../staging/storage/whale-wallet.js';

test('hasWhaleWallet 白名单只包含 example.cat-arena 与 example.crazy-flasher4',()=>{
  assert.equal(hasWhaleWallet('example.cat-arena'), true);
  assert.equal(hasWhaleWallet('example.crazy-flasher4'), true);
  assert.equal(hasWhaleWallet('example.sample'), false);
  assert.equal(hasWhaleWallet('example.minesweeping'), false);
  assert.equal(hasWhaleWallet('example.other'), false);
});

test('cumulative usage earns only whole millions, retains remainder, never adds cache/reasoning twice',()=>{
  const w=new WhaleWallet();w.observeUsage('a',{totalTokens:900000,cacheReadTokens:800000,reasoningTokens:100000});assert.equal(w.status().balance,0);w.observeUsage('a',{totalTokens:900000});w.observeUsage('a',{totalTokens:1000000});assert.equal(w.status().balance,10);w.observeUsage('b',{totalTokens:2500000});assert.equal(w.status().balance,30);assert.equal(w.status().nextRewardIn,500000);for(const usage of [{totalTokens:-2},{totalTokens:1.2},{totalTokens:NaN},{inputTokens:1000000,outputTokens:1000000}])w.observeUsage('invalid',usage);assert.equal(w.status().totalTokens,3500000);w.close();
});
test('exchange and persistent game snapshot are atomic, idempotent, scoped by player and revision',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whale-wallet-')),db=path.join(dir,'wallet.sqlite');let w=new WhaleWallet(db,'alice');w.observeUsage('paid',{totalTokens:1000000});
  const save={action:'saveGame',operationId:'s1',expectedRevision:0,state:{coins:160,characterId:'spark'}};w.command(save);
  const exchange={action:'exchange',operationId:'x1',expectedRevision:1,amount:3};const result=w.command(exchange);assert.equal(result.wallet.balance,7);assert.equal(result.state.coins,190);assert.equal(w.command(exchange).replayed,true);assert.equal(w.status().balance,7);assert.throws(()=>w.command({...exchange,amount:4}),/更改参数/);assert.throws(()=>w.command({...exchange,operationId:'x2',expectedRevision:2,amount:8}),/余额不足/);assert.equal(w.command({action:'status'}).revision,2);w.close();
  w=new WhaleWallet(db,'alice');assert.equal(w.command({action:'status'}).state.coins,190);assert.equal(w.status().totalTokens,1000000);assert.equal(w.command(exchange).state.coins,190);assert.throws(()=>w.command({...save,operationId:'stale'}),/其他窗口/);w.close();const other=new WhaleWallet(db,'bob');assert.equal(other.status().balance,0);assert.equal(other.command({action:'status'}).state,null);other.close();
  await fs.rm(dir,{recursive:true,force:true});
});
test('invalid exchange inputs and missing profiles cannot debit currency; fake token fields have no effect',()=>{
  const w=new WhaleWallet();w.observeUsage('a',{totalTokens:1000000});assert.throws(()=>w.command({action:'exchange',operationId:'x',expectedRevision:0,amount:1}),/选择角色/);
  w.command({action:'saveGame',operationId:'s',expectedRevision:0,state:{coins:160},totalTokens:1e12});
  for(const amount of [-1,0,.5,10001,Infinity,'1'])assert.throws(()=>w.command({action:'exchange',operationId:'x',expectedRevision:1,amount}));assert.equal(w.status().balance,10);assert.throws(()=>w.command({action:'credit',amount:100}));w.close();
});
test('real Cordis waterfall observes all profile model calls, preserves chunks and counts partial failures once',async()=>{
  const ctx=new Context(),w=new WhaleWallet(),dispose=attachWhaleMeter(ctx,w);
  const options={provider:'test',model:'model',messages:[{secret:'must not store'}]},chunks=[{type:'usage',usage:{totalTokens:600000}},{type:'usage',usage:{totalTokens:1000000}},{type:'text-delta',text:'ok'},{type:'finish',reason:'stop'}];
  const stream=()=>ctx.waterfall({},'llm/stream',options,async function*(){yield* chunks});const received=[];for await(const c of stream())received.push(c);assert.deepEqual(received,chunks);assert.equal(w.status().balance,10);
  await assert.rejects(async()=>{for await(const c of ctx.waterfall({},'llm/stream',options,async function*(){yield {type:'usage',usage:{totalTokens:1000000}};throw Error('network')}))void c;},/network/);assert.equal(w.status().balance,20);dispose();for await(const c of stream())void c;assert.equal(w.status().balance,20);assert.equal(w.status().meterActive,false);w.close();
});
import {apply,MemorySaveBackend} from '../staging/index.js';
test('Host rejects spoofed, suspended and foreign-game wallet commands; ledger cannot accept client token claims',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wallet-host-'));await fs.mkdir(path.join(dir,'cat'));await fs.writeFile(path.join(dir,'cat/gamecenter.json'),JSON.stringify({schemaVersion:1,id:'example.cat-arena'}));
 const ctx=new Context();ctx.provide('llm',{listProviders:async()=>[],listModels:async()=>[]});const api=apply(ctx,{playerId:'wallet-player',storageBackend:new MemorySaveBackend(),previewDir:dir});t.after(async()=>{api.dispose();await fs.rm(dir,{recursive:true,force:true})});
 const hs=api.service.handshake({runtimeInstanceId:'cat',gameId:'example.cat-arena',gameVersion:'0.5.0',sdkVersion:'1.0.0',bridgeVersion:1,nonce:'n',saveId:'save-preview',previewId:'cat',launchToken:'wallet-0123456789abcdef0123456789abcdef'});assert.equal(hs.ok,true);api.service.leaseStatus({runtimeToken:hs.runtimeToken});const runtimeToken=hs.runtimeToken;
 assert.equal((await api.service.walletAction({runtimeToken:'spoof',action:'status'})).ok,false);
 assert.equal((await api.service.walletAction({runtimeToken,action:'status',totalTokens:1000000})).ok,false);assert.equal(api.service.walletStatus({}).wallet.balance,0);
 assert.equal((await api.service.walletAction({runtimeToken,action:'saveGame',operationId:'s',expectedRevision:0,state:{coins:160}})).ok,true);
 assert.equal((await api.service.walletAction({runtimeToken,action:'exchange',operationId:'x',expectedRevision:1,amount:1})).ok,false);
 api.service.wallet.observeUsage('trusted-host-only',{totalTokens:1000000});const paid=await api.service.walletAction({runtimeToken,action:'exchange',operationId:'x',expectedRevision:1,amount:1});assert.equal(paid.state.coins,170);assert.equal(paid.wallet.balance,9);
 api.service.suspendRuntime({runtimeToken,generation:hs.generation});assert.equal((await api.service.walletAction({runtimeToken,action:'status'})).ok,false);api.service.resumeRuntime({runtimeToken,generation:hs.generation});assert.equal((await api.service.walletAction({runtimeToken,action:'status'})).ok,true);
 const other=api.service.handshake({runtimeInstanceId:'mines',gameId:'example.minesweeping',gameVersion:'1.1.0',sdkVersion:'1.0.0',bridgeVersion:1,nonce:'n',saveId:'save-preview',launchToken:'other-0123456789abcdef0123456789abcdef'});api.service.leaseStatus({runtimeToken:other.runtimeToken});assert.equal((await api.service.walletAction({runtimeToken:other.runtimeToken,action:'status'})).ok,false);
});
test('production Host data directory persists earned whales and purchased gold across plugin recreation',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wallet-production-'));let api;
 const open=()=>{const ctx=new Context();ctx.provide('llm',{listProviders:async()=>[],listModels:async()=>[]});return apply(ctx,{playerId:'persistent-player',dataDir:dir})};
 try{api=open();api.service.wallet.observeUsage('live-fixture',{totalTokens:1550000});api.service.wallet.command({action:'saveGame',operationId:'first',expectedRevision:0,state:{coins:160}});api.service.wallet.command({action:'exchange',operationId:'charge',expectedRevision:1,amount:2});api.dispose();api=open();assert.equal(api.service.wallet.status().balance,8);assert.equal(api.service.wallet.status().nextRewardIn,450000);assert.equal(api.service.wallet.command({action:'status'}).state.coins,180);}
 finally{api?.dispose();await fs.rm(dir,{recursive:true,force:true})}
});
