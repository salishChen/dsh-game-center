import test from 'node:test';import assert from 'node:assert/strict';import {validGameCategories,parseCatalogIssueBody,matchApproval} from '../dist/index.js';
const entry={schemaVersion:1,gameId:'example.flash',title:'Flash',summary:'Game',version:'1.0.0',source:{repository:'https://github.com/example/flash',ref:'main',commit:'a'.repeat(40),manifestPath:'gamecenter.json',manifestDigest:'sha256:'+'b'.repeat(64),bundleDigest:'sha256:'+'c'.repeat(64)}};
const parse=value=>parseCatalogIssueBody('```gamecenter-json\n'+JSON.stringify(value)+'\n```');
test('category metadata is validated without breaking old Issues or changing approval tuples',()=>{
 assert.equal(parse(entry).ok,true);const result=parse({...entry,categories:['动作','射击']});assert.equal(result.ok,true);assert.deepEqual(result.entry.categories,['动作','射击']);
 for(const categories of [[],['unknown'],['动作','动作'],['动作','射击','策略','冒险'],'动作',[1]]){assert.equal(validGameCategories(categories),false);assert.equal(parse({...entry,categories}).ok,false);}
 const approval={gameId:entry.gameId,repository:entry.source.repository,commit:entry.source.commit,manifestDigest:entry.source.manifestDigest,bundleDigest:entry.source.bundleDigest};assert.equal(matchApproval(result.entry,[approval]).ok,true);
});
