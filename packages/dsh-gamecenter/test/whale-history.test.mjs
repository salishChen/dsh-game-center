import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Context} from '@deepseek-ai/cordis';
import {WhaleWallet} from '../staging/storage/whale-wallet.js';
import {WhaleHistoryBootstrap,historicalSessionUsage} from '../staging/storage/whale-history.js';
import {apply,MemorySaveBackend} from '../staging/index.js';
const now=Date.parse('2026-10-22T08:00:00Z'),month=30*24*60*60*1000;
const event=(seq,time,tokens,type='assistant/message')=>({seq,time,type,data:{usage:{totalTokens:tokens}}});
const log=(id,events,inheritedEventCount=0)=>({session:{id},events,inheritedEventCount});
const query=logs=>({listSessions:async()=>Object.keys(logs).map(id=>({header:{id}})),readSession:async id=>logs[id]});
test('first month counts owned final replies and failed attempts, excludes forks and both time boundaries correctly',async()=>{
 const w=new WhaleWallet(':memory:','p',now),recent=event(0,now-10,1200000),attempt={seq:1,time:now-9,type:'assistant/attempt',data:{stream:[{type:'chunk',chunk:{type:'usage',usage:{totalTokens:200000}}},{type:'chunk',chunk:{type:'usage',usage:{totalTokens:300000}}}]}};
 const logs={parent:log('parent',[recent,attempt,event(2,now-month-1,10000000),event(3,now-month,500000),event(4,now,700000),event(5,now+1,900000)]),child:log('child',[recent,attempt,event(2,now-8,1000000)],2)};
 await new WhaleHistoryBootstrap(w,query(logs)).start();assert.equal(w.status().totalTokens,3000000);assert.equal(w.status().balance,30);assert.equal(w.status().history.calls,4);assert.equal(w.status().history.status,'completed');w.close();
});
test('usage snapshots and final summaries are one request, missing totals do not invent tokens',()=>{
 const records=historicalSessionUsage('s',log('s',[{...event(0,now-1,1000000),data:{usage:{totalTokens:1000000},stream:[{type:'chunk',chunk:{type:'usage',usage:{totalTokens:1000000}}}]}},{seq:1,time:now-1,type:'assistant/message',data:{usage:{inputTokens:500000,outputTokens:500000}}},event(2,now-1,-1)]),now-month,now);assert.equal(records.length,1);assert.equal(records[0].tokens,1000000);
});
test('historical grant combines with concurrent live usage and concurrent scans never issue it twice',async()=>{
 const w=new WhaleWallet(':memory:','p',now),logs={s:log('s',[event(0,now-1,2250000),event(1,now+1,750000)])};w.observeUsage('live',{totalTokens:750000});
 await Promise.all([new WhaleHistoryBootstrap(w,query(logs)).start(),new WhaleHistoryBootstrap(w,query(logs)).start()]);assert.equal(w.status().totalTokens,3000000);assert.equal(w.status().balance,30);assert.equal(w.status().history.tokens,2250000);w.close();
});
test('completion and original month survive restart; another month cannot trigger a second grant',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whale-history-')),file=path.join(dir,'wallet.sqlite');let w=new WhaleWallet(file,'p',now);await new WhaleHistoryBootstrap(w,query({s:log('s',[event(0,now-1,1500000)])})).start();w.close();
 w=new WhaleWallet(file,'p',now+month);let reads=0;await new WhaleHistoryBootstrap(w,{listSessions:async()=>{reads++;throw Error('must not scan twice')},readSession:async()=>{throw Error()}}).start();assert.equal(reads,0);assert.equal(w.status().balance,10);assert.equal(w.status().nextRewardIn,500000);assert.equal(w.status().history.to,now);w.close();await fs.rm(dir,{recursive:true,force:true});
});
test('failure pays nothing and retry uses the original window; disposal cannot mark incomplete history complete',async()=>{
 const w=new WhaleWallet(':memory:','p',now);let fail=true,clock=now;
 const q={listSessions:async()=>[{header:{id:'good'}},{header:{id:'bad'}}],readSession:async id=>{if(id==='bad'&&fail)throw Error('unreadable');return log(id,[event(0,now-1,1000000)])}};
 const job=new WhaleHistoryBootstrap(w,q,()=>clock);await job.start();assert.equal(w.status().totalTokens,0);assert.equal(w.status().history.status,'failed');fail=false;clock+=60001;await job.start();assert.equal(w.status().balance,20);w.close();
 const cancelled=new WhaleWallet(':memory:','p',now);let release;const blocker=new Promise(r=>release=r),j=new WhaleHistoryBootstrap(cancelled,{listSessions:async()=>{await blocker;return[]},readSession:async()=>{throw Error()}});const pending=j.start();j.stop();release();await pending;assert.notEqual(cancelled.status().history.status,'completed');cancelled.close();
});
test('invalid or overflowing batches roll back and an unmarked legacy ledger is never blindly double credited',()=>{
 const w=new WhaleWallet(':memory:','p',now);assert.throws(()=>w.finishHistory([{id:'history:a',tokens:1000000},{id:'history:b',tokens:Infinity}]));assert.equal(w.status().balance,0);assert.notEqual(w.status().history.status,'completed');w.close();
});
test('production apply automatically binds actual Cordis optional query/persistence services and begins backfill',async()=>{
 const ctx=new Context();ctx.provide('llm',{listProviders:async()=>[],listModels:async()=>[]});ctx.provide('sessionPersistence',{});const t=Date.now();ctx.provide('sessionQuery',query({s:log('s',[event(0,t-1000,2500000)])}));
 const api=apply(ctx,{playerId:'history-player',storageBackend:new MemorySaveBackend()});try{for(let n=0;n<100&&api.service.wallet.status().history.status!=='completed';n++)await new Promise(r=>setTimeout(r,5));assert.equal(api.service.wallet.status().history.status,'completed');assert.equal(api.service.walletStatus({}).wallet.balance,20);}finally{api.dispose()}
});
test('preexisting unmarked legacy usage is flagged instead of issuing a second historical reward',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whale-legacy-')),file=path.join(dir,'wallet.sqlite');let w=new WhaleWallet(file,'p',now);w.observeUsage('old-live',{totalTokens:1000000});w.db.exec('DROP TABLE whale_history');w.close();w=new WhaleWallet(file,'p',now);let scans=0;await new WhaleHistoryBootstrap(w,{listSessions:async()=>{scans++;return[]},readSession:async()=>{throw Error()}}).start();assert.equal(scans,0);assert.equal(w.status().history.status,'legacy-unverified');assert.equal(w.status().balance,10);w.close();await fs.rm(dir,{recursive:true,force:true});
});
