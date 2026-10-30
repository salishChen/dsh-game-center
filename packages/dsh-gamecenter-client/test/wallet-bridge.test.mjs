import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {connectSDKToDispatcher} from '../src/bridge/dispatcher.js';
import {createRuntimeLease} from '../src/runtime/lease.js';
import {generateSdkBootstrapSource} from '../src/runtime/assembler.js';

test('wallet SDK reaches the bound dispatcher with no credentials and is denied while suspended',async t=>{
  const lease=createRuntimeLease({gameId:'example.cat-arena',saveId:'save-preview',runtimeInstanceId:'r',nonce:'n',generation:1});let calls=0;
  const link=connectSDKToDispatcher({lease,onCheckpoint:()=>{},onWalletCommand:input=>{calls++;assert.equal(input.runtimeToken,undefined);return {ok:true,wallet:{balance:10},revision:0,state:null};}});t.after(()=>link.dispose());
  await link.sdk.lifecycle.ready();assert.equal((await link.sdk.wallet.command({action:'status'})).wallet.balance,10);
  link.sdk.lifecycle.register({pause:()=>{},resume:()=>{}});await link.dispatcher.control('suspend');await assert.rejects(link.sdk.wallet.command({action:'status'}),{code:'PAUSED'});assert.equal(calls,1);
});
test('embedded wallet SDK queues until pairing and preserves the idempotency key and revision',async()=>{
  let initialize;const messages=[],window={parent:{postMessage:()=>{}},addEventListener:(name,fn)=>initialize=fn,removeEventListener:()=>{}};
  vm.runInNewContext(generateSdkBootstrapSource({runtimeInstanceId:'r',nonce:'n'}),{window,console});
  const input={action:'exchange',operationId:'same-id-on-retry',expectedRevision:7,amount:2},promise=window.__DSH_GAMECENTER_SDK__.wallet.command(input);
  const port={start:()=>{},postMessage(message){messages.push(message);queueMicrotask(()=>port.onmessage({data:{requestId:message.requestId,ok:true,payload:{ok:true,wallet:{balance:8},revision:8,state:{coins:180}}}}));}};
  assert.equal(messages.length,0);initialize({data:{type:'dsh-gamecenter:port'},ports:[port]});assert.equal((await promise).state.coins,180);assert.equal(messages[0].method,'wallet.command');assert.deepEqual(JSON.parse(JSON.stringify(messages[0].payload)),input);
});
test('wallet whitelist allows cat-arena and crazy-flasher4, denies other games', async () => {
  const SAMPLE_GAME = 'example.sample';
  const allowed = ['example.cat-arena', 'example.crazy-flasher4'];
  assert.equal(allowed.includes(SAMPLE_GAME), false);
  assert.equal(allowed.includes('example.cat-arena'), true);
  assert.equal(allowed.includes('example.crazy-flasher4'), true);
  assert.equal(allowed.includes('example.minesweeping'), false);
});
