import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {Context} from '@deepseek-ai/cordis';
import {apply,MemorySaveBackend} from '../staging/index.js';import {fetchCommitArtifacts} from '../staging/remote/game-center-service.js';
test('Flash wallet authorization binds the trusted manifest/game lease and blocks suspended, spoofed, foreign and extra identity fields',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flash-host-'));await fs.mkdir(path.join(dir,'flash'));await fs.writeFile(path.join(dir,'flash/gamecenter.json'),JSON.stringify({schemaVersion:1,id:'example.crazy-flasher4'}));
 const ctx=new Context();ctx.provide('llm',{listProviders:async()=>[],listModels:async()=>[]});const api=apply(ctx,{playerId:'flash-test',storageBackend:new MemorySaveBackend(),previewDir:dir});
 try{const h=api.service.handshake({runtimeInstanceId:'flash',gameId:'example.crazy-flasher4',gameVersion:'0.1.0',sdkVersion:'1.0.0',bridgeVersion:1,nonce:'n',saveId:'save-preview',previewId:'flash',launchToken:'flash-0123456789abcdef0123456789abcdef'});assert.equal(h.ok,true);api.service.leaseStatus({runtimeToken:h.runtimeToken});
  assert.equal((await api.service.walletAction({runtimeToken:h.runtimeToken,action:'status'})).ok,true);assert.equal((await api.service.walletAction({runtimeToken:h.runtimeToken,action:'status',gameId:'example.cat-arena'})).ok,false);
  api.service.suspendRuntime({runtimeToken:h.runtimeToken,generation:h.generation});assert.equal((await api.service.walletAction({runtimeToken:h.runtimeToken,action:'status'})).ok,false);api.service.resumeRuntime({runtimeToken:h.runtimeToken,generation:h.generation});assert.equal((await api.service.walletAction({runtimeToken:h.runtimeToken,action:'status'})).ok,true);
  await fs.writeFile(path.join(dir,'flash/gamecenter.json'),JSON.stringify({schemaVersion:1,id:'example.cat-arena'}));assert.equal((await api.service.walletAction({runtimeToken:h.runtimeToken,action:'status'})).ok,false);
 }finally{api.dispose();await fs.rm(dir,{recursive:true,force:true});}
});
test('fixed-commit downloader fetches declared offline script chunks, rejects escapes and missing dependencies',async()=>{
 const files={'gamecenter.json':JSON.stringify({schemaVersion:1,runtime:{entry:'dist/index.html'}}),'dist/index.html':'<html><script src="game.js"></script><script src="asset-0.js"></script><script src="core.js"></script></html>','dist/game.js':'/* game */','dist/asset-0.js':'/* bytes */','dist/core.js':'/* runtime */'};const calls=[];
 const options={repository:'https://github.com/example/flash',commit:'a'.repeat(40),fetcher:async url=>{calls.push(url);const key=Object.keys(files).find(p=>url.endsWith('/'+p));return new Response(key?files[key]:'missing',{status:key?200:404});}};
 const r=await fetchCommitArtifacts(options);assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.bundledSource.files.map(f=>f.path),['dist/index.html','dist/game.js','dist/asset-0.js','dist/core.js']);assert.ok(calls.every(url=>url.includes('/'+'a'.repeat(40)+'/')));
 delete files['dist/core.js'];assert.equal((await fetchCommitArtifacts(options)).ok,false);files['dist/index.html']='<script src="../escape.js"></script>';assert.equal((await fetchCommitArtifacts(options)).ok,false);
});
