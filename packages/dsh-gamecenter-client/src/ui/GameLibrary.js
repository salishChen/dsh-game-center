// @ts-check
// @ts-expect-error supplied by DSH
import {createElement as h,useState} from 'react';
import {ARENA_NAME} from '@dsh-gamecenter/protocol';
import {LibraryArtwork} from './LibraryArtwork.js';
import {SafeMarkdown} from './SafeMarkdown.js';
import {GameMediaPlaceholder} from './GameMediaPlaceholder.js';
import {filterLibraryItems,itemCategories,sortLibraryItems,paginateItems} from './library-search.js';
// 【提交判定唯一入口 · 2026-10-27】与 GameCenterOverlay 的卸载/启动共用同一套口径，见 entry-commit.js。
import {resolveEntryCommit} from './entry-commit.js';

/** @param {string} id */
function gameInfo(id) {
  if(id.includes('crazy-flasher4'))return {eyebrow:'BACK IN THE LINE OF FIRE.',genre:'动作射击 · 原版 Flash',summary:'重返闪客快打4的枪林弹雨。探索原版关卡、购买武器，在游戏中心保存进度，使用鲸鲸币兑换游戏金钱。',tags:['原版关卡','武器商店','鲸鲸币充值']};
  if(id.includes('cat-arena'))return {eyebrow:'BUILD A MACHINE. CHALLENGE A MIND.',genre:'战车组装 · AI 对战',summary:'与拟人 AI 一同驾驶战车。冒险闯关收集加成，或在同样的 300 金币预算下，挑战真正由大模型组装的对手。',tags:['冒险模式','AI 对战','自由组装']};
  if(id.includes('landlord'))return {eyebrow:'YOUR HAND. YOUR MOVE.',genre:'策略棋牌 · AI 对局',summary:'与 AI 同桌较量，观察出牌、判断牌型，把握每一次出手机会。',tags:['斗地主','AI 对局','牌局复盘']};
  if(id.includes('minesweep'))return {eyebrow:'ONE MORE SAFE MOVE.',genre:'经典益智 · 扫雷',summary:'从一个安全格开始，用数字推理雷的位置。翻开棋盘，享受经典扫雷的节奏。',tags:['经典规则','数字推理','单人游戏']};
  return {eyebrow:'READY WHEN YOU ARE.',genre:'小游戏',summary:'从游戏库选择游戏，开始下一段游玩时光。',tags:['游戏库']};
}

/** Presentation only: approval/installation/launch remain in Host and Overlay.
 * @param {{entries:any[],previews:any[],fixture:boolean,hiddenCount:number,loading:boolean,refreshing:boolean,error:string|null,installError:string|null,installingGameId:string|null,uninstallingGameId?:string|null,scannedAt:string|null,stale:boolean,onRefresh:()=>void,onInstall:(entry:any)=>void,onUninstall?:(entry:any)=>void,onLaunch:(entry:any)=>void,onPreview:(entry:any)=>void}} props */
export function GameLibrary(props) {
  const [query,setQuery]=useState('');
  const [filter,setFilter]=useState('all');
  const [category,setCategory]=useState('all');
  const [sortBy,setSortBy]=useState('default');
  const [selectedKey,setSelectedKey]=useState('');
  const [page,setPage]=useState(1);
  const [confirmUninstall,setConfirmUninstall]=useState(false);
  const PAGE_SIZE=10;

  const items=[
    ...props.previews.map(p=>({key:`preview:${p.previewId}`,id:p.gameId,title:p.gameId==='example.cat-arena'?ARENA_NAME:p.name,version:p.version,preview:true,entry:p})),
    ...props.entries.map(e=>({key:`catalog:${e.gameId}`,id:e.gameId,title:e.gameId==='example.cat-arena'?ARENA_NAME:e.title,version:e.version,preview:false,entry:e})),
  ];
  const filtered=filterLibraryItems(items,{query,status:filter,category});
  const sorted=sortLibraryItems(filtered,sortBy);
  const {pagedItems,totalPages,currentPage}=paginateItems(sorted,page,PAGE_SIZE);

  const categoryItems=filterLibraryItems(items,{query,status:filter});
  const categories=[...new Set(items.flatMap(itemCategories))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  const selected=sorted.find(i=>i.key===selectedKey)??pagedItems[0]??sorted[0]??null;
  const info=selected?gameInfo(selected.id):null;
  const counts={all:items.length,installed:items.filter(i=>!i.preview&&i.entry.installed).length,previews:props.previews.length};
  /** @param {any} item */
  const status=item=>item.preview?'本地预览':item.entry.installed?'已安装':item.entry.approvalState==='approved'?'可安装':'未审批';
  const busy=selected&&!selected.preview&&props.installingGameId===selected.id;
  // 【已安装必须可启动 · 2026-10-26】installed 为真但 installedCommit 缺失/非 commit 形态时，
  // 不能把按钮点亮成「开始游戏」——那会点下去必报「未找到已安装版本」。
  // 这类状态只可能来自落后/脏的目录快照，按「未安装」处理，让用户走一次安全安装自愈。
  /** @param {any} item */
  const isLaunched=item=>Boolean(item&&!item.preview&&item.entry.installed&&typeof item.entry.installedCommit==='string'&&item.entry.installedCommit.length>0);
  const blocked=selected&&!selected.preview&&!isLaunched(selected)&&selected.entry.approvalState!=='approved';
  const action=selected?(selected.preview?'启动预览':isLaunched(selected)?'开始游戏':busy?'正在安装…':blocked?'未审批不可安装':'安全安装'):'';
  const updated=props.scannedAt&&Number.isFinite(Date.parse(props.scannedAt))?new Date(props.scannedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):null;
  return h('div',{className:'gc-library','data-gamecenter-catalog':''},
    h('aside',{className:'gc-sidebar','aria-label':'游戏库导航'},
      h('div',{className:'gc-sidebar-heading'},h('span',{},'我的游戏库'),h('span',{className:'gc-count'},items.length)),
      h('label',{className:'gc-search'},h('span',{'aria-hidden':'true'},'⌕'),h('input',{type:'search',placeholder:'搜索游戏','aria-label':'搜索游戏',value:query,onChange:(/** @type {any} */ e)=>{setQuery(e.target.value);setPage(1);}})),
      h('nav',{className:'gc-filters','aria-label':'安装状态'},
        ...[{id:'all',label:'全部游戏',icon:'▦'},{id:'installed',label:'已安装',icon:'↓'},{id:'previews',label:'本地预览',icon:'◇'}].map(f=>h('button',{key:f.id,type:'button','data-library-filter':f.id,'aria-pressed':filter===f.id,onClick:()=>{setFilter(f.id);setPage(1);},className:filter===f.id?'is-active':''},h('span',{'aria-hidden':'true'},f.icon),f.label,h('span',{className:'gc-count'},counts[/** @type {'all'|'installed'|'previews'} */(f.id)])))),
      h('div',{className:'gc-sidebar-divider'}),
      h('label',{className:'gc-category'},h('span',{},'游戏分类'),h('select',{'aria-label':'游戏分类','data-library-category':'',value:category,onChange:(/** @type {any} */ e)=>{setCategory(e.target.value);setPage(1);}},h('option',{value:'all'},`全部分类 (${categoryItems.length})`),...categories.map(c=>h('option',{key:c,value:c},`${c} (${categoryItems.filter(i=>itemCategories(i).includes(c)).length})`)))),
      h('label',{className:'gc-category','data-library-sort':''},
        h('span',{},'列表排序'),
        h('select',{
          'aria-label':'列表排序',
          'data-library-sort-select':'',
          value:sortBy,
          onChange:(/** @type {any} */ e)=>{setSortBy(e.target.value);setPage(1);}
        },
          h('option',{value:'default'},'默认推荐'),
          h('option',{value:'downloads_desc'},'按下载量排序 (最高优先)'),
          h('option',{value:'published_desc'},'按发布时间排序 (最新优先)')
        )
      ),
      h('p',{className:'gc-overline'},'游戏列表'),
      h('div',{className:'gc-sidebar-games'},...sorted.map(i=>{
        const coverUrl = i.entry?.cover?.url || i.entry?.display?.cover?.url;
        return h('button',{key:i.key,type:'button',className:selected?.key===i.key?'gc-game-link is-active':'gc-game-link','aria-pressed':selected?.key===i.key,onClick:()=>setSelectedKey(i.key)},
          h('span',{className:'gc-mini-art'},h(LibraryArtwork,{gameId:i.id,coverUrl,alt:i.title})),
          h('span',{},h('span',{className:'gc-link-title'},i.title),h('small',{},status(i)))
        );
      })),
      h('div',{className:'gc-sidebar-foot'},h('span',{className:'gc-connection-dot'}),'本地游戏 · 随时开玩',h('small',{},'你的下一局，从这里开始。')),
    ),
    h('main',{className:'gc-library-main'},
      h('div',{className:'gc-library-heading'},h('div',{},h('p',{className:'gc-overline'},'YOUR COLLECTION'),h('h2',{},'游戏库')),h('button',{type:'button',className:'gc-button gc-button-quiet','data-gamecenter-action':'refresh',disabled:props.loading||props.refreshing,onClick:props.onRefresh},h('span',{'aria-hidden':'true'},'↻ '),props.loading||props.refreshing?'正在刷新…':'刷新目录')),
      (props.error||props.installError)&&h('div',{role:'alert',className:'gc-alert gc-alert-error'},props.error,props.error&&props.installError?' · ':null,props.installError),
      props.fixture&&h('div',{'data-gamecenter-badge':'fixture',className:'gc-alert'},'本地目录预览 · 非 GitHub 正式上架，未审批版本不可安装。'),
      props.hiddenCount>0&&h('p',{'data-gamecenter-hidden-pending':'',className:'gc-catalog-note'},`${props.hiddenCount} 款游戏尚未通过审核，暂不显示`),
      selected&&info?h('section',{className:'gc-feature','data-library-selected':selected.key,'aria-label':selected.title},
        h(LibraryArtwork,{gameId:selected.id,className:'gc-feature-art',coverUrl:selected.entry?.cover?.url||selected.entry?.display?.cover?.url,alt:selected.title}),h('div',{className:'gc-feature-shade'}),
        h('div',{className:'gc-feature-content'},h('div',{className:'gc-feature-badges'},h('span',{className:'gc-badge'},itemCategories(selected).join(' · ')),h('span',{className:selected.preview?'gc-badge gc-badge-preview':'gc-badge gc-badge-ready'},status(selected))),h('p',{className:'gc-feature-eyebrow'},info.eyebrow),h('h3',{},selected.title),h('p',{className:'gc-feature-description'},selected.preview?info.summary:(selected.entry.display?.summary||selected.entry.summary||info.summary)),h('div',{className:'gc-tags'},...info.tags.map(tag=>h('span',{key:tag},tag))),
          h('div',{className:'gc-play-row'},
            h('button',{type:'button',className:'gc-button gc-play','data-gamecenter-action':selected.preview?'preview':isLaunched(selected)?'launch':'install',disabled:Boolean(busy||blocked),onClick:()=>selected.preview?props.onPreview(selected.entry):isLaunched(selected)?props.onLaunch(selected.entry):props.onInstall(selected.entry)},h('span',{'aria-hidden':'true'},isLaunched(selected)||selected.preview?'▶':'↓'),action),
            !selected.preview && isLaunched(selected) && typeof props.onUninstall === 'function' &&
              h('button',{
                type: 'button',
                className: 'gc-button gc-button-danger',
                'data-gamecenter-action': 'uninstall',
                disabled: props.uninstallingGameId === selected.id,
                onClick: () => setConfirmUninstall(true),
              }, props.uninstallingGameId === selected.id ? '正在卸载…' : '卸载游戏'),
            h('div',{className:'gc-version'},`版本 ${selected.version}`,h('small',{},selected.preview?'独立预览版本 · 未上架':isLaunched(selected)?'已安装到本机':'通过审批后由平台安装'))
          ),
          confirmUninstall && selected && !selected.preview && isLaunched(selected) && h('div',{
            role: 'alertdialog',
            'aria-label': '确认卸载游戏',
            className: 'gc-uninstall-confirm',
            'data-gamecenter-uninstall-dialog': '',
          },
            h('div',{className:'gc-uninstall-dialog-content'},
              h('h4',{},`确定要卸载《${selected.title}》吗？`),
              h('p',{},'卸载仅移除本地游戏代码与资源包。您的云端与本地游戏存档数据将完好保留，重新安装后可继续游玩。'),
              h('div',{className:'gc-uninstall-dialog-actions'},
                h('button',{
                  type: 'button',
                  className: 'gc-button',
                  'data-action': 'cancel',
                  onClick: () => setConfirmUninstall(false),
                }, '取消'),
                h('button',{
                  type: 'button',
                  className: 'gc-button gc-button-danger',
                  'data-action': 'confirm',
                  onClick: () => {
                    setConfirmUninstall(false);
                    props.onUninstall?.(selected.entry);
                  },
                }, '确认卸载')
              )
            )
          )
        ),
      ):h('div',{'data-gamecenter-catalog-empty':'',className:'gc-empty',role:'status'},h('span',{'aria-hidden':'true'},'▦'),h('h3',{},props.loading?'正在加载游戏库…':query||category!=='all'?'没有找到匹配的游戏':filter==='installed'?'还没有安装游戏':'暂时没有可用游戏'),h('p',{},query||category!=='all'?'试试其他关键词或分类，或清除筛选。':filter==='installed'?'选择「全部游戏」查看可安装的游戏与本地预览。':'刷新目录后，可用的游戏会显示在这里。'),(query||filter!=='all'||category!=='all')&&h('button',{className:'gc-button',onClick:()=>{setQuery('');setFilter('all');setCategory('all');setPage(1);}},'查看全部游戏')),
      h('section',{className:'gc-collection','aria-label':'游戏卡片'},
        h('div',{className:'gc-section-heading'},
          h('h3',{},filter==='previews'?'本地受控预览':filter==='installed'?'已安装游戏':'全部游戏'),
          h('span',{},`${sorted.length} 个版本${totalPages>1?` · 第 ${currentPage}/${totalPages} 页`:''}`)
        ),
        h('div',{className:'gc-game-grid'},...pagedItems.map(i=>{
          const downloads = i.entry?.stats?.downloads;
          const downloadTag = typeof downloads === 'number' ? ` · ${downloads}次下载` : '';
          const coverUrl = i.entry?.cover?.url || i.entry?.display?.cover?.url;
          return h('button',{key:i.key,type:'button',className:selected?.key===i.key?'gc-game-card is-selected':'gc-game-card',...(i.preview?{'data-gamecenter-preview':i.entry.previewId}:{'data-gamecenter-card':i.id}),'aria-pressed':selected?.key===i.key,'aria-label':`查看 ${i.title} ${status(i)} v${i.version}`,onClick:()=>setSelectedKey(i.key)},
            h('div',{className:'gc-card-cover'},h(LibraryArtwork,{gameId:i.id,coverUrl,alt:i.title}),h('span',{className:i.preview?'gc-card-label gc-preview-label':'gc-card-label'},status(i))),
            h('div',{className:'gc-card-copy'},h('strong',{},i.title),h('span',{},itemCategories(i).join(' · ')),
              h('div',{className:'gc-card-bottom'},h('small',{},`v${i.version}${downloadTag}`),h('span',{'aria-hidden':'true'},selected?.key===i.key?'已选择':'查看游戏 →')))
          );
        })),
        totalPages > 1 && h('nav',{className:'gc-pagination','data-gamecenter-pagination':'','aria-label':'分页导航'},
          h('button',{
            type:'button',
            className:'gc-page-btn',
            'data-page-action':'prev',
            disabled:currentPage<=1,
            onClick:()=>setPage(p=>Math.max(1,p-1))
          },'← 上一页'),
          h('span',{className:'gc-page-info'},`第 ${currentPage} / ${totalPages} 页`),
          h('button',{
            type:'button',
            className:'gc-page-btn',
            'data-page-action':'next',
            disabled:currentPage>=totalPages,
            onClick:()=>setPage(p=>Math.min(totalPages,p+1))
          },'下一页 →')
        )
      ),
      selected&&h('details',{className:'gc-details'},h('summary',{},'游戏介绍与版本信息'),h('div',{className:'gc-details-body'},
        selected.preview?h('p',{},selected.entry.label||'本地受控预览，尚未正式上架。'):h('div',{},selected.entry.display?.descriptionMarkdown?h(SafeMarkdown,{text:selected.entry.display.descriptionMarkdown,display:selected.entry.display,repository:selected.entry.repository}):h('p',{'data-gamecenter-no-display':''},selected.entry.summary||'未提供简介'),h(GameMediaPlaceholder,{cover:selected.entry.display?.cover,screenshots:selected.entry.display?.screenshots})),
        h('dl',{},
          h('div',{},h('dt',{},'游戏标识'),h('dd',{},selected.id)),
          h('div',{},h('dt',{},'版本'),h('dd',{},selected.version)),
          selected.entry?.stats?.downloads !== undefined && h('div',{},h('dt',{},'累计下载'),h('dd',{},`${selected.entry.stats.downloads} 次`)),
          selected.entry?.updatedAt && h('div',{},h('dt',{},'发布时间'),h('dd',{},new Date(selected.entry.updatedAt).toLocaleString('zh-CN'))),
          h('div',{},h('dt',{},'来源'),h('dd',{},selected.preview?'本机预览目录':props.fixture?'本地 fixture 目录':'游戏目录')),
          // 【显示与实际操作保持一致 · 2026-10-27】已安装时按钮打的是磁盘上那份的提交，
          // 这里就不能再显示目录里的最新版，否则用户会看到一个从未被启动过的提交号。
          !selected.preview&&h('div',{},h('dt',{},'提交'),h('dd',{},resolveEntryCommit(selected.entry)||selected.entry.commit))
        )
      )),
      h('footer',{className:'gc-library-footer'},h('span',{},props.stale?'当前展示缓存目录':updated?`目录更新于 ${updated}`:'游戏中心'),h('span',{},'鲸鲸币可在支持的游戏内兑换金币')),
    ),
  );
}
