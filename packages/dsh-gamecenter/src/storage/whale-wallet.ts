import {DatabaseSync} from 'node:sqlite'
import {randomBytes} from 'node:crypto'
import {inflateSync} from 'node:zlib'

const MILLION=1_000_000
const CAT='example.cat-arena'
export const FLASH_GAME='example.crazy-flasher4'
export function hasWhaleWallet(gameId:string){return gameId===CAT||gameId===FLASH_GAME}
/** Host-owned ledger. Neither token counts nor whale credits are accepted over RPC. */
export class WhaleWallet {
  private readonly db:DatabaseSync
  private closed=false
  meterActive=false
  constructor(dbPath=':memory:',readonly playerId='test-host-player',nowMs=Date.now()){
    this.db=new DatabaseSync(dbPath)
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS whale_history(player TEXT PRIMARY KEY,from_ms INTEGER NOT NULL,to_ms INTEGER NOT NULL,status TEXT NOT NULL,tokens INTEGER NOT NULL DEFAULT 0,calls INTEGER NOT NULL DEFAULT 0,scanned INTEGER NOT NULL DEFAULT 0,sessions INTEGER NOT NULL DEFAULT 0,error TEXT);
      CREATE TABLE IF NOT EXISTS whale_accounts(player TEXT PRIMARY KEY,tokens INTEGER NOT NULL DEFAULT 0,spent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS whale_usage(player TEXT NOT NULL,id TEXT NOT NULL,tokens INTEGER NOT NULL,PRIMARY KEY(player,id));
      CREATE TABLE IF NOT EXISTS whale_games(player TEXT NOT NULL,game TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(player,game));
      CREATE TABLE IF NOT EXISTS whale_operations(player TEXT NOT NULL,id TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(player,id));`)
    this.db.prepare('INSERT OR IGNORE INTO whale_accounts(player) VALUES(?)').run(playerId)
    // Older ledgers without an activation boundary cannot safely be backfilled by guessing.
    const legacy=(this.db.prepare('SELECT tokens FROM whale_accounts WHERE player=?').get(playerId) as {tokens:number}).tokens>0
    this.db.prepare('INSERT OR IGNORE INTO whale_history(player,from_ms,to_ms,status) VALUES(?,?,?,?)').run(playerId,nowMs-30*24*60*60*1000,nowMs,legacy?'legacy-unverified':'pending')
  }
  close(){if(!this.closed){this.closed=true;this.db.close()}}
  private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const out=fn();this.db.exec('COMMIT');return out}catch(e){this.db.exec('ROLLBACK');throw e}}
  status(){
    const a=this.db.prepare('SELECT tokens,spent FROM whale_accounts WHERE player=?').get(this.playerId) as {tokens:number;spent:number}
    const history=this.db.prepare('SELECT * FROM whale_history WHERE player=?').get(this.playerId) as {from_ms:number;to_ms:number;status:string;tokens:number;calls:number;scanned:number;sessions:number;error:string|null}
    return {history:{status:history.status,from:history.from_ms,to:history.to_ms,tokens:history.tokens,calls:history.calls,scannedSessions:history.scanned,totalSessions:history.sessions,...(history.error?{error:history.error}:{})},balance:Math.floor(a.tokens/MILLION)*10-a.spent,totalTokens:a.tokens,nextRewardIn:MILLION-a.tokens%MILLION,earned:Math.floor(a.tokens/MILLION)*10,meterActive:this.meterActive,scope:'current-profile-first-month-and-live-llm',rate:{tokens:MILLION,coins:10,goldPerCoin:10}}
  }
  /** Cumulative snapshots for one real stream; retries are separate stream identities. */
  observeUsage(id:string,usage:unknown){
    const total=(usage as {totalTokens?:unknown}|null)?.totalTokens
    if(!Number.isSafeInteger(total)||(total as number)<0)return
    this.transaction(()=>{
      const previous=this.db.prepare('SELECT tokens FROM whale_usage WHERE player=? AND id=?').get(this.playerId,id) as {tokens:number}|undefined
      const next=total as number,delta=Math.max(0,next-(previous?.tokens??0));if(!delta)return
      const current=this.status().totalTokens;if(!Number.isSafeInteger(current+delta))throw Error('Token 总量超出安全整数范围')
      this.db.prepare('INSERT INTO whale_usage VALUES(?,?,?) ON CONFLICT(player,id) DO UPDATE SET tokens=excluded.tokens').run(this.playerId,id,next)
      this.db.prepare('UPDATE whale_accounts SET tokens=tokens+? WHERE player=?').run(delta,this.playerId)
    })
  }
  historyProgress(status:'scanning'|'failed',scanned?:number,sessions?:number,error?:string){
    this.db.prepare("UPDATE whale_history SET status=?,scanned=COALESCE(?,scanned),sessions=COALESCE(?,sessions),error=? WHERE player=? AND status IN ('pending','scanning','failed')").run(status,scanned??null,sessions??null,error??null,this.playerId)
  }
  /** Entire historical grant and completion marker commit together. Reruns never reissue coins. */
  finishHistory(rows:{id:string;tokens:number}[]){
    return this.transaction(()=>{
      const before=this.status();if(before.history.status==='completed')return before.history
      if(before.history.status==='legacy-unverified')throw Error('已有旧用量缺少时间边界，不能重复补发')
      const unique=new Map<string,number>();for(const row of rows){if(!row.id.startsWith('history:')||!Number.isSafeInteger(row.tokens)||row.tokens<0)throw Error('历史用量不合法');unique.set(row.id,Math.max(unique.get(row.id)||0,row.tokens))}
      let delta=0;for(const [id,tokens] of unique){const old=this.db.prepare('SELECT tokens FROM whale_usage WHERE player=? AND id=?').get(this.playerId,id) as {tokens:number}|undefined;delta+=Math.max(0,tokens-(old?.tokens||0));if(!Number.isSafeInteger(delta))throw Error('历史用量超出安全范围')}
      if(!Number.isSafeInteger(before.totalTokens+delta))throw Error('历史总量超出安全范围')
      for(const [id,tokens] of unique)this.db.prepare('INSERT INTO whale_usage VALUES(?,?,?) ON CONFLICT(player,id) DO UPDATE SET tokens=MAX(tokens,excluded.tokens)').run(this.playerId,id,tokens)
      this.db.prepare('UPDATE whale_accounts SET tokens=tokens+? WHERE player=?').run(delta,this.playerId)
      this.db.prepare("UPDATE whale_history SET status='completed',tokens=?,calls=?,error=NULL WHERE player=?").run(delta,unique.size,this.playerId)
      return this.status().history
    })
  }
  private game(gameId:string){return this.db.prepare('SELECT revision,state FROM whale_games WHERE player=? AND game=?').get(this.playerId,gameId) as {revision:number;state:string}|undefined}
  command(input:Record<string,any>,gameId=CAT){
    if(!hasWhaleWallet(gameId))throw Error('该游戏未开通鲸鲸币兑换')
    if(input.action==='status'){const g=this.game(gameId);return {ok:true,wallet:this.status(),revision:g?.revision??0,state:g?JSON.parse(g.state):null}}
    if(!['saveGame','exchange'].includes(input.action)||typeof input.operationId!=='string'||!/^[\w:.-]{1,128}$/.test(input.operationId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw Error('钱包请求不合法')
    const body=JSON.stringify({...(gameId===CAT?{}:{gameId}),action:input.action,expectedRevision:input.expectedRevision,...(input.action==='exchange'?{amount:input.amount}:{state:input.state})})
    if(new TextEncoder().encode(body).byteLength>128*1024)throw Error('工坊进度超限')
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT input,result FROM whale_operations WHERE player=? AND id=?').get(this.playerId,input.operationId) as {input:string;result:string}|undefined
      if(previous){if(previous.input!==body)throw Error('同一操作不能更改参数');const latest=this.game(gameId)!;return {...JSON.parse(previous.result),wallet:this.status(),revision:latest.revision,state:JSON.parse(latest.state),replayed:true}}
      const g=this.game(gameId);if((g?.revision??0)!==input.expectedRevision)throw Error('游戏进度已被其他窗口修改，请重新打开游戏')
      let state=input.state
      if(input.action==='exchange'){
        if(!Number.isSafeInteger(input.amount)||input.amount<1||input.amount>10000)throw Error('兑换数量必须为 1–10000 的整数')
        if(!g)throw Error(gameId===CAT?'请先选择角色并保存工坊':'请先开始游戏并保存进度')
        if(this.status().balance<input.amount)throw Error('鲸鲸币余额不足')
        state=JSON.parse(g.state);if(!Number.isSafeInteger(state.coins+input.amount*10))throw Error('金币超出范围')
        state.coins+=input.amount*10
        this.db.prepare('UPDATE whale_accounts SET spent=spent+? WHERE player=?').run(input.amount,this.playerId)
      }
      if(!state||typeof state!=='object'||Array.isArray(state)||!Number.isSafeInteger(state.coins)||state.coins<0)throw Error('金币进度不合法')
      if(gameId===FLASH_GAME)validateFlashState(state)
      const revision=(g?.revision??0)+1
      this.db.prepare('INSERT INTO whale_games VALUES(?,?,?,?) ON CONFLICT(player,game) DO UPDATE SET revision=excluded.revision,state=excluded.state').run(this.playerId,gameId,revision,JSON.stringify(state))
      const result={ok:true,wallet:this.status(),revision,state}
      this.db.prepare('INSERT INTO whale_operations VALUES(?,?,?,?)').run(this.playerId,input.operationId,body,JSON.stringify(result));return result
    })
  }
}

/** Only original checkpoint fields are persisted; no script, URL or client wallet balance. */
function validateFlashState(state:Record<string,any>){
  const numeric=['allkilled','manhp','武器槽1_弹夹内子弹','武器槽1_子弹数','武器槽2_弹夹内子弹','武器槽2_子弹数','武器槽4_弹夹内子弹','武器槽4_子弹数','刀种','刀威力','主线任务解锁']
  const strings=['武器槽1','武器槽2','武器槽4','nickname']
  if(Object.keys(state).some(k=>!['coins','stats','world'].includes(k))||!state.stats||typeof state.stats!=='object'||Array.isArray(state.stats)||Object.keys(state.stats).length!==numeric.length+strings.length||state.coins>2_000_000_000)throw Error('闪客快打存档格式不合法')
  for(const [key,value] of Object.entries(state.stats)){
    if(numeric.includes(key)){if(!Number.isSafeInteger(value)||(value as number)<0||(value as number)>2_000_000_000)throw Error('闪客快打数值不合法')}
    else if(!strings.includes(key)||typeof value!=='string'||value.length>64)throw Error('闪客快打存档字段不合法')
  }
  if(state.world!==undefined){
    let world=state.world
    if(world?.encoding!==undefined){
      if(world.encoding!=='deflate-json-v1'||Object.keys(world).some(k=>!['encoding','data'].includes(k))||typeof world.data!=='string'||world.data.length>128*1024||!/^[-A-Za-z0-9+/]*={0,2}$/.test(world.data))throw Error('闪客快打场景编码不合法')
      try{world=JSON.parse(new TextDecoder().decode(inflateSync(Buffer.from(world.data,'base64'),{maxOutputLength:1024*1024})))}catch{throw Error('闪客快打场景解压失败或超限')}
    }
    validateFlashWorld(world)
  }
}

function validateFlashWorld(world:any){
  const record=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v)
  const safeKey=(k:string)=>k.length>0&&k.length<=128&&!['__proto__','prototype','constructor'].includes(k)&&!k.startsWith('_')&&!k.startsWith('cf4')
  const variables=(v:any)=>record(v)&&Object.keys(v).length<=600&&Object.entries(v).every(([k,x])=>safeKey(k)&&(typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x)||typeof x==='string'&&x.length<2048))
  if(!record(world)||Object.keys(world).some(k=>!['schemaVersion','frame','root','nodes'].includes(k))||world.schemaVersion!==1||!Number.isInteger(world.frame)||world.frame<14||world.frame>315||!variables(world.root)||!Array.isArray(world.nodes)||world.nodes.length>1500)throw Error('闪客快打场景格式不合法')
  const paths=new Set<string>()
  for(const n of world.nodes){
    if(!record(n)||Object.keys(n).some(k=>!['path','depth','frame','transform','vars','linkage'].includes(k))||!Array.isArray(n.path)||!n.path.length||n.path.length>12||n.path[0]!=='gameworld'||!n.path.every((s:any)=>typeof s==='string'&&safeKey(s)&&!/[.\/\\:]/.test(s))||!Number.isInteger(n.depth)||Math.abs(n.depth)>2_000_000_000||!Number.isInteger(n.frame)||n.frame<1||n.frame>10000||!Array.isArray(n.transform)||n.transform.length!==7||!n.transform.slice(0,6).every((x:any)=>typeof x==='number'&&Number.isFinite(x))||typeof n.transform[6]!=='boolean'||!variables(n.vars)||n.linkage!==undefined&&(typeof n.linkage!=='string'||n.linkage.length>128))throw Error('闪客快打场景对象不合法')
    const key=JSON.stringify(n.path);if(paths.has(key))throw Error('闪客快打场景路径重复');paths.add(key)
  }
}

/** DSH llm.streamWithRegistration uses ctx.waterfall(this,'llm/stream',options,next).
 * Observe raw usage only; never retain messages, reasoning or credentials. */
export function attachWhaleMeter(ctx:{on?:(event:string,listener:(...args:any[])=>any,options?:{global?:boolean;prepend?:boolean})=>any},wallet:WhaleWallet):()=>void {
  if(!ctx.on)return ()=>{}
  const dispose=ctx.on('llm/stream',(_options:unknown,next:()=>AsyncIterable<any>)=>{
    const id=randomBytes(24).toString('base64url')
    return (async function*(){for await(const chunk of next()){if(chunk.type==='usage'&&wallet.meterActive){try{wallet.observeUsage(id,chunk.usage)}catch(e){wallet.meterActive=false;console.warn('鲸鲸币 Token 记账失败',e)}}yield chunk}})()
  },{global:true,prepend:true})
  wallet.meterActive=true
  return ()=>{wallet.meterActive=false;if(typeof dispose==='function')dispose()}
}
