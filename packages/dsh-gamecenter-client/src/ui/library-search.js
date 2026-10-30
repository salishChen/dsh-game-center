// @ts-check
import {GAME_CATEGORIES} from '@dsh-gamecenter/protocol';
/** @param {any} item @returns {string[]} */
export function itemCategories(item){
 const values=Array.isArray(item.entry?.categories)?item.entry.categories:[];
 const clean=[...new Set(values.filter((/** @type {any} */ v)=>GAME_CATEGORIES.includes(v)))];
 return clean.length?clean:['未分类'];
}
/** @param {string} text */
const normalize=text=>text.normalize('NFKC').toLocaleLowerCase().trim();
/** @param {any[]} items @param {{query?:string,status?:string,category?:string}} options */
export function filterLibraryItems(items,{query='',status='all',category='all'}={}){
 const terms=normalize(query).split(/\s+/).filter(Boolean);
 return items.filter(i=>{
  if(status==='installed'&&(i.preview||!i.entry.installed))return false;
  if(status==='previews'&&!i.preview)return false;
  const categories=itemCategories(i);
  if(category!=='all'&&!categories.includes(category))return false;
  const text=normalize([i.title,i.id,i.entry.summary,i.entry.display?.summary,i.entry.display?.descriptionMarkdown,...categories].filter(Boolean).join(' '));
  return terms.every(term=>text.includes(term));
 });
}

/**
 * 按指定规则对游戏列表排序（支持按下载量降序、按发布/更新时间降序、默认排序）。
 * @param {any[]} items
 * @param {'default'|'downloads_desc'|'published_desc'|string} [sortBy]
 * @returns {any[]}
 */
export function sortLibraryItems(items, sortBy = 'default') {
  if (sortBy === 'downloads_desc' || sortBy === 'downloads') {
    return [...items].sort((a, b) => {
      const downA = Number(a.entry?.stats?.downloads ?? a.entry?.downloads ?? 0);
      const downB = Number(b.entry?.stats?.downloads ?? b.entry?.downloads ?? 0);
      if (downB !== downA) return downB - downA;
      return a.title.localeCompare(b.title, 'zh-CN');
    });
  }
  if (sortBy === 'published_desc' || sortBy === 'publishedAt') {
    return [...items].sort((a, b) => {
      const timeA = Date.parse(a.entry?.updatedAt ?? a.entry?.publishedAt ?? a.entry?.fetchedAt ?? '') || 0;
      const timeB = Date.parse(b.entry?.updatedAt ?? b.entry?.publishedAt ?? b.entry?.fetchedAt ?? '') || 0;
      if (timeB !== timeA) return timeB - timeA;
      return a.title.localeCompare(b.title, 'zh-CN');
    });
  }
  return items;
}

/**
 * 纯函数：根据页码和每页大小切分列表并计算总页数与当前安全页码。
 * @param {any[]} items
 * @param {number} [page]
 * @param {number} [pageSize]
 * @returns {{pagedItems: any[], totalPages: number, currentPage: number, totalCount: number}}
 */
export function paginateItems(items, page = 1, pageSize = 10) {
  const safePageSize = Math.max(1, Math.floor(pageSize || 10));
  const totalCount = Array.isArray(items) ? items.length : 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));
  const currentPage = Math.min(Math.max(1, Math.floor(page || 1)), totalPages);
  const startIndex = (currentPage - 1) * safePageSize;
  const pagedItems = Array.isArray(items) ? items.slice(startIndex, startIndex + safePageSize) : [];
  return { pagedItems, totalPages, currentPage, totalCount };
}
