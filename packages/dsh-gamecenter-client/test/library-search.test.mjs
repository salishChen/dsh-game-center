import test from 'node:test';import assert from 'node:assert/strict';
import {filterLibraryItems,itemCategories,sortLibraryItems,paginateItems} from '../src/ui/library-search.js';
const items=[{id:'a',title:'闪客快打4',preview:true,entry:{categories:['动作','射击'],summary:'原版关卡 武器商店'}},{id:'b',title:'Mystery Board',preview:false,entry:{categories:['棋牌','策略'],installed:true,display:{descriptionMarkdown:'推理 AI 对战'}}},{id:'c',title:'Old Game',preview:false,entry:{installed:false}}];
test('search covers categories and descriptions, normalizes width/case, ANDs words, and combines with category/status',()=>{
 assert.deepEqual(filterLibraryItems(items,{query:'射击 商店'}).map(i=>i.id),['a']);assert.deepEqual(filterLibraryItems(items,{query:'ｍｙｓｔｅｒｙ AI',status:'installed',category:'棋牌'}).map(i=>i.id),['b']);assert.equal(filterLibraryItems(items,{query:'AI',status:'previews'}).length,0);assert.deepEqual(filterLibraryItems(items,{category:'未分类'}).map(i=>i.id),['c']);assert.equal(filterLibraryItems(items,{query:'\n  '}).length,3);
});
test('categories come from metadata, with explicit uncategorized fallback and no game-id guessing',()=>{
 assert.deepEqual(itemCategories({id:'example.cat-arena',entry:{}}),['未分类']);assert.deepEqual(itemCategories({entry:{categories:['动作','动作','<script>']}}),['动作']);
});
test('sortLibraryItems supports sorting by downloads and publication date',()=>{
 const sortItems = [
   { id: '1', title: 'Game A', entry: { stats: { downloads: 10 }, updatedAt: '2026-10-20T10:00:00Z' } },
   { id: '2', title: 'Game B', entry: { stats: { downloads: 99 }, updatedAt: '2026-10-23T10:00:00Z' } },
   { id: '3', title: 'Game C', entry: { stats: { downloads: 50 }, updatedAt: '2026-10-22T10:00:00Z' } },
   { id: '4', title: 'Game D', entry: {} },
 ];
 const byDownloads = sortLibraryItems(sortItems, 'downloads_desc');
 assert.deepEqual(byDownloads.map(i => i.id), ['2', '3', '1', '4']);

 const byPublished = sortLibraryItems(sortItems, 'published_desc');
 assert.deepEqual(byPublished.map(i => i.id), ['2', '3', '1', '4']);

 const byDefault = sortLibraryItems(sortItems, 'default');
 assert.deepEqual(byDefault.map(i => i.id), ['1', '2', '3', '4']);
});
test('paginateItems correctly partitions items and clamps page bounds', () => {
 const list = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'];
 const p1 = paginateItems(list, 1, 3);
 assert.equal(p1.totalPages, 3);
 assert.equal(p1.currentPage, 1);
 assert.deepEqual(p1.pagedItems, ['g1', 'g2', 'g3']);

 const p2 = paginateItems(list, 2, 3);
 assert.equal(p2.currentPage, 2);
 assert.deepEqual(p2.pagedItems, ['g4', 'g5', 'g6']);

 const p3 = paginateItems(list, 3, 3);
 assert.equal(p3.currentPage, 3);
 assert.deepEqual(p3.pagedItems, ['g7', 'g8']);

 const pClampHigh = paginateItems(list, 999, 3);
 assert.equal(pClampHigh.currentPage, 3);
 assert.deepEqual(pClampHigh.pagedItems, ['g7', 'g8']);

 const pClampLow = paginateItems(list, 0, 3);
 assert.equal(pClampLow.currentPage, 1);
 assert.deepEqual(pClampLow.pagedItems, ['g1', 'g2', 'g3']);

 const pEmpty = paginateItems([], 1, 10);
 assert.equal(pEmpty.totalPages, 1);
 assert.equal(pEmpty.currentPage, 1);
 assert.deepEqual(pEmpty.pagedItems, []);

 // 默认单页容量为 10 款游戏
 const twentyGames = Array.from({ length: 25 }, (_, i) => `game-${i + 1}`);
 const page1Default = paginateItems(twentyGames, 1);
 assert.equal(page1Default.totalPages, 3);
 assert.equal(page1Default.currentPage, 1);
 assert.equal(page1Default.pagedItems.length, 10);
 assert.equal(page1Default.pagedItems[0], 'game-1');
 assert.equal(page1Default.pagedItems[9], 'game-10');

 const page3Default = paginateItems(twentyGames, 3);
 assert.equal(page3Default.currentPage, 3);
 assert.equal(page3Default.pagedItems.length, 5);
 assert.equal(page3Default.pagedItems[4], 'game-25');
});

test('game card grid has fixed card width 216px and GameLibrary uses PAGE_SIZE=10', async () => {
 const fs = await import('node:fs');
 const path = await import('node:path');
 const { fileURLToPath } = await import('node:url');
 const here = path.dirname(fileURLToPath(import.meta.url));
 const styles = fs.readFileSync(path.resolve(here, '../src/ui/library-styles.js'), 'utf8');
 const library = fs.readFileSync(path.resolve(here, '../src/ui/GameLibrary.js'), 'utf8');

 assert.match(styles, /\.gc-game-grid\s*\{[^}]*repeat\(auto-fill,216px\)/);
 assert.match(styles, /\.gc-game-card\s*\{[^}]*width:216px/);
 assert.match(library, /PAGE_SIZE\s*=\s*10/);
});
