import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameSessionController} from '../src/runtime/session-controller.js';
import {createBridgeDispatcher} from '../src/bridge/dispatcher.js';
import {createGameCenterSDK} from '../src/sdk/index.js';
import {createRuntimeLease} from '../src/runtime/lease.js';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

function node(tag='div') {
  return {tagName:tag,style:{},children:[],parentNode:null,isConnected:true,
    setAttribute(name,value){this[name]=value;},
    appendChild(child){assert.equal(child.parentNode,null,'never reparent live iframe');this.children.push(child);child.parentNode=this;},
    removeChild(child){this.children=this.children.filter(c=>c!==child);child.parentNode=null;},
    getBoundingClientRect(){return {left:280,top:164,width:900,height:590};}};
}
test('route hide is synchronous; returning retains frame/window and resumes without saving', async t=>{
  const original=globalThis.document;const body=node('body');globalThis.document={body,createElement:tag=>node(tag)};
  t.after(()=>{globalThis.document=original;});
  const calls=[];
  const service={suspendRuntime:async()=>{calls.push('host-suspend');return {ok:true};},resumeRuntime:async()=>{calls.push('host-resume');return {ok:true};},abandonRuntime:async()=>{calls.push('abandon');return {ok:true};}};
  const ctrl=createGameSessionController({requestPause:async()=>{throw new Error('must not save');},getService:()=>service});
  t.after(()=>ctrl.abandon());
  const session={supportsSave:false,runtimeToken:'t',runtimeInstanceId:'r',launchToken:'l',lease:{generation:1,state:'running'},docHtml:'<html></html>',dispatcher:{control:async action=>calls.push(action),dispose:()=>calls.push('dispose')}};
  ctrl.attach(session,{sandbox:'allow-scripts',frameMode:'srcdoc',anchor:node()});
  const frame=ctrl.getFrame();const host=frame.parentNode;
  const pausing=ctrl.unbind();assert.equal(host.style.visibility,'hidden');assert.equal(host.style.pointerEvents,'none');
  await pausing;assert.equal(ctrl.snapshot().state,'suspended');assert.equal(session.lease.clockFrozen,true);
  await ctrl.bind(node());assert.equal(ctrl.getFrame(),frame);assert.equal(frame.parentNode,host);assert.equal(host.parentNode,body);
  assert.equal(host.style.width,'900px');assert.equal(host.style.height,'590px');assert.equal(host.style.visibility,'visible');
  assert.deepEqual(calls,['host-suspend','suspend','host-resume','resume']);
  const result=await ctrl.finalize('close');assert.equal(result.kind,'saved');assert.equal(ctrl.getFrame(),null);assert.equal(calls.at(-1),'dispose');
});
test('a late layout callback cannot redisplay a game after leaving its route', async t=>{
  const original=globalThis.document;globalThis.document={body:node('body'),createElement:tag=>node(tag)};t.after(()=>{globalThis.document=original;});
  const service={suspendRuntime:async()=>({ok:true}),resumeRuntime:async()=>({ok:true})};
  const ctrl=createGameSessionController({requestPause:async()=>({kind:'saved',message:''}),getService:()=>service});t.after(()=>ctrl.abandon());
  const anchor=node();ctrl.attach({lease:{generation:1},dispatcher:{control:async()=>{}},docHtml:'',runtimeToken:'t'},{sandbox:'allow-scripts',frameMode:'srcdoc',anchor});
  await ctrl.unbind();assert.equal(ctrl.align(anchor),false);assert.equal(ctrl.getFrame().parentNode.style.visibility,'hidden');
});

test('paired MessagePort suspends and resumes SDK clock without final save acknowledgement', async t=>{
  const channel=new MessageChannel();
  const lease=createRuntimeLease({gameId:'example.game',saveId:'save-default',runtimeInstanceId:'r',nonce:'n',generation:1});
  let pauses=0,resumes=0,saves=0;
  const dispatcher=createBridgeDispatcher({lease,port:channel.port1,onPauseAck:()=>{saves++;}});
  const sdk=createGameCenterSDK({port:channel.port2});
  t.after(()=>{dispatcher.dispose();sdk.disposeInternal();channel.port1.close();channel.port2.close();});
  sdk.lifecycle.register({pause:()=>{pauses++;},resume:()=>{resumes++;}});
  await sdk.lifecycle.ready();assert.equal(sdk.clock.isClockFrozen(),false);
  await dispatcher.control('suspend');assert.equal(sdk.clock.isClockFrozen(),true);assert.equal(pauses,1);
  const elapsed=sdk.clock.getElapsedMs();
  await assert.rejects(sdk.ai.generate({slot:'boardGeneration',operationId:'paused',input:{}}),{code:'PAUSED'});
  assert.equal(sdk.clock.getElapsedMs(),elapsed);assert.equal(saves,0);
  await dispatcher.control('resume');assert.equal(sdk.clock.isClockFrozen(),false);assert.equal(resumes,1);assert.equal(saves,0);
});

test('production plugin pause waiter settles a real SDK acknowledgement exactly once', async t=>{
  let registration;
  vm.runInNewContext(fs.readFileSync(new URL('../staging/client.js',import.meta.url),'utf8'),{
    window:{__ModuleLoader__:{load:r=>{registration=r;}}},crypto:webcrypto,
    setTimeout,clearTimeout,setInterval,clearInterval,AbortController,TextEncoder,console,
  });
  const plugin=registration.factory(name=>name==='react'?{createElement:(type,props)=>({type,props})}:{});
  let main;
  const disposers=[];
  plugin.apply({
    effect(cb,label){if(label.includes('remote'))return;const stop=cb();if(typeof stop==='function')disposers.push(stop);},
    slots:{inject:(name,cb)=>cb(),register:(options,component)=>{if(options.name==='main')main=component;return ()=>{};}},
    locale:{bind:()=>key=>key,register:()=>()=>{}},
  });
  t.after(()=>disposers.reverse().forEach(stop=>stop()));
  const props=main().props;
  const lease=props.beginRuntime({gameId:'saved.game',saveId:'save-default',runtimeInstanceId:'regression'});
  const channel=new MessageChannel();
  let acknowledgements=0;
  const dispatcher=createBridgeDispatcher({lease,port:channel.port1,onCheckpoint:async()=>({revision:1}),onPauseAck:payload=>{
    acknowledgements++;props.onSaveAck(payload);
  }});
  const sdk=createGameCenterSDK({port:channel.port2});
  t.after(()=>{dispatcher.dispose();sdk.disposeInternal();channel.port1.close();channel.port2.close();});
  sdk.lifecycle.register({pause:()=>({state:'last board'})});
  await sdk.lifecycle.ready();
  await sdk.save.checkpoint({operationId:'before-close',expectedRevision:0,state:{board:1},elapsedGameMs:0,rngState:'1',installedCommit:'a'.repeat(40),gameStateSchemaVersion:1,modelBindings:{}});
  const outcome=props.requestPause('close');
  assert.equal(props.requestPause('close'),outcome,'concurrent close shares the waiter');
  assert.equal(dispatcher.triggerPause({reason:'close'}),true);
  assert.equal(dispatcher.triggerPause({reason:'close'}),false,'pause signal is sent once');
  let timer;
  const result=await Promise.race([outcome,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('pause waiter did not settle')),500);})]).finally(()=>clearTimeout(timer));
  assert.equal(result.kind,'saved');assert.equal(acknowledgements,1);assert.equal(lease.state,'destroyed');
});

test('explicit close releases a failed save session even when Host is unavailable', async t=>{
  const original=globalThis.document;globalThis.document={body:node('body'),createElement:tag=>node(tag)};t.after(()=>{globalThis.document=original;});
  const calls=[];
  const ctrl=createGameSessionController({requestPause:async()=>({kind:'refused',message:'already paused'}),
    getService:()=>({pause:async()=>{throw new Error('offline');},abandonRuntime:async()=>{calls.push('revoke');throw new Error('offline');}}),
    destroyRuntime:()=>calls.push('destroy'),
  });
  ctrl.attach({lease:{generation:1},supportsSave:true,supportsResume:true,docHtml:'',dispatcher:{dispose:()=>calls.push('dispose')},unbindTheme:()=>calls.push('unbind')},{sandbox:'allow-scripts',frameMode:'srcdoc',anchor:node()});
  const result=await ctrl.finalize('close');
  assert.equal(result.kind,'closed');assert.match(result.message,/本次保存未确认/);assert.doesNotMatch(result.message,/已保存/);
  assert.equal(ctrl.getFrame(),null);assert.equal(ctrl.snapshot().session,null);assert.deepEqual(calls,['revoke','dispose','unbind','destroy']);
});

test('closing a suspended unsaved game does not depend on resuming its Host lease', async t=>{
  const original=globalThis.document;globalThis.document={body:node('body'),createElement:tag=>node(tag)};t.after(()=>{globalThis.document=original;});
  let resumes=0;
  const service={suspendRuntime:async()=>({ok:true}),resumeRuntime:async()=>{resumes++;throw new Error('expired');},abandonRuntime:async()=>({ok:true})};
  const ctrl=createGameSessionController({requestPause:async()=>{throw new Error('must not save');},getService:()=>service});
  ctrl.attach({lease:{generation:1},supportsSave:false,docHtml:'',dispatcher:{control:async()=>{},dispose:()=>{}}},{sandbox:'allow-scripts',frameMode:'srcdoc',anchor:node()});
  await ctrl.unbind();await ctrl.finalize('close');assert.equal(resumes,0);assert.equal(ctrl.getFrame(),null);
});
