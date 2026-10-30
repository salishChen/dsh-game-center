import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {connectSDKToDispatcher} from '../src/bridge/dispatcher.js';
import {createRuntimeLease} from '../src/runtime/lease.js';
import {generateSdkBootstrapSource,assembleGameDocument} from '../src/runtime/assembler.js';

test('game commands cross the paired SDK port, preserve authoritative public response and stop while suspended',async t=>{
  const lease=createRuntimeLease({gameId:'example.landlord',saveId:'save-preview',runtimeInstanceId:'r',nonce:'n',generation:1});let calls=0;
  const link=connectSDKToDispatcher({lease,onCheckpoint:()=>{throw new Error('no saves');},onGameCommand:input=>{calls++;assert.equal(input.action,'state');assert.equal(input.runtimeToken,undefined);return {ok:true,view:{seat:0,ownHand:[0,4],bottomCards:[],history:[]}};}});t.after(()=>link.dispose());
  await link.sdk.lifecycle.ready();const result=await link.sdk.game.command({action:'state',operationId:'state-1'});assert.deepEqual(result.view.ownHand,[0,4]);assert.equal(result.view.hands,undefined);
  link.sdk.lifecycle.register({pause:()=>{},resume:()=>{}});await link.dispatcher.control('suspend');await assert.rejects(link.sdk.game.command({action:'state',operationId:'hidden'}),{code:'PAUSED'});assert.equal(calls,1);
});
test('embedded iframe SDK queues game commands until a paired port is supplied',async()=>{
  let initialize;const messages=[];const fakeWindow={parent:{postMessage:()=>{}},addEventListener:(name,fn)=>{initialize=fn;},removeEventListener:()=>{}};
  vm.runInNewContext(generateSdkBootstrapSource({runtimeInstanceId:'r',nonce:'n'}),{window:fakeWindow,console});
  const promise=fakeWindow.__DSH_GAMECENTER_SDK__.game.command({action:'state',operationId:'state-1'});
  const port={start:()=>{},postMessage(message){messages.push(message);queueMicrotask(()=>port.onmessage({data:{requestId:message.requestId,ok:true,payload:{ok:true,view:{ownHand:[1],bottomCards:[]}}}}));}};
  assert.equal(messages.length,0);initialize({data:{type:'dsh-gamecenter:port'},ports:[port]});
  const result=await promise;assert.equal(messages[0].method,'game.command');assert.deepEqual(JSON.parse(JSON.stringify(result.view)),{ownHand:[1],bottomCards:[]});
});
test('shipped Dou Dizhu assembles offline and carries no rule authority, deck or opponent hand serialization',()=>{
  const root=new URL('../../../',import.meta.url);
  const files=['gamecenter.json','dist/index.html','dist/style.css','dist/insights.js','dist/game.js'].map(path=>({path,content:fs.readFileSync(new URL('games/doudizhu/'+path,root),'utf8')}));
  const html=assembleGameDocument({entryPath:'dist/index.html',files,options:{runtimeInstanceId:'r',nonce:'n'}});
  assert.match(html,/game\.command/);assert.match(html,/connect-src 'none'/);assert.match(html,/AI 只接收自己的手牌/);
  assert.doesNotMatch(files.find(f=>f.path==='dist/game.js').content,/state\.hands|view\.hands|createLandlordGame|prepareCall/);
});
