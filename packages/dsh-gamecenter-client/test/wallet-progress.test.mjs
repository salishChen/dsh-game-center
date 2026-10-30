import test from 'node:test';import assert from 'node:assert/strict';import {saveFlashBeforeClose} from '../src/runtime/wallet-progress.js';
test('Flash close freezes the current scene and commits it using its own revision before closing',async()=>{
 const calls=[],scene={coins:20,stats:{},world:{frame:268}},session={gameId:'example.crazy-flasher4',runtimeToken:'client-secret',lease:{generation:1},dispatcher:{control:async()=>({snapshot:{walletRevision:3,progress:scene,pending:false}})}};
 const service={leaseStatus:async()=>({state:'running'}),walletAction:async p=>{calls.push(structuredClone(p));return {ok:true};}};assert.equal(await saveFlashBeforeClose(session,service),true);assert.equal(calls[0].expectedRevision,3);assert.equal(calls[0].state.world.frame,268);assert.equal(calls[0].runtimeToken,'client-secret');
 scene.world.frame=73;assert.equal(await saveFlashBeforeClose(session,service),true);assert.deepEqual(calls[1],calls[0]);
});
test('unconfirmed payments cannot be overwritten by closing, and an inactive game cannot use the close wallet path',async()=>{
 const session={gameId:'example.crazy-flasher4',runtimeToken:'secret',lease:{generation:1},dispatcher:{control:async()=>({snapshot:{walletRevision:3,progress:{coins:0},pending:true}})}};let writes=0;const service={leaseStatus:async()=>({state:'running'}),walletAction:async()=>{writes++;return {ok:true};}};await assert.rejects(saveFlashBeforeClose(session,service),/尚未确认/);assert.equal(writes,0);assert.equal(await saveFlashBeforeClose({...session,gameId:'foreign.game'},service),false);
});
