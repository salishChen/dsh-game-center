import test from 'node:test';import assert from 'node:assert/strict';import {parseGitHubIssuePayload,listCatalog} from '../dist/index.js';
const base={schemaVersion:1,gameId:'example.game',title:'Game',summary:'Summary',version:'1.0.0',source:{repository:'https://github.com/example/game',ref:'main',commit:'a'.repeat(40),manifestPath:'gamecenter.json',manifestDigest:'sha256:'+'b'.repeat(64),bundleDigest:'sha256:'+'c'.repeat(64)}};
const parse=(categories,line='')=>parseGitHubIssuePayload({number:1,body:line+'\n```gamecenter-json\n'+JSON.stringify({...base,...(categories?{categories}:{})})+'\n```'},{owner:'example',repo:'catalog'});
test('legacy human categories and new JSON categories agree, conflicts and invalid human categories reject',()=>{
 assert.deepEqual(parse(undefined,'- **游戏分类 / Categories**：益智').entryView.entry.categories,['益智']);assert.deepEqual(parse(['动作','射击'],'- **游戏分类 / Categories**：射击、动作').entryView.entry.categories,['射击','动作']);assert.equal(parse(['棋牌'],'- **游戏分类 / Categories**：益智').ok,false);assert.equal(parse(undefined,'- **游戏分类 / Categories**：假分类').ok,false);
});
test('catalog wire projection carries Issue categories',async()=>{
 const parsed=parse(['动作','射击']);const r=await listCatalog({mode:'fixture',approvals:[],fixtureEntries:[parsed.entryView.entry],gameLibraryDir:'nonexistent-fixture-library'});assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.entries[0].categories,['动作','射击']);
});
