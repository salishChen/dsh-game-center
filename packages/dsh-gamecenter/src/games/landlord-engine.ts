/** Authoritative, in-memory three-seat Dou Dizhu. Hidden hands never cross this module's view boundary. */
export type Seat = 0 | 1 | 2
export type Play = { kind: string; length: number; high: number; chain: number }
export type Move = { cards: number[]; label: string }
export type LandlordState = {
  revision: number; phase: 'bidding' | 'playing' | 'finished'; hands: number[][]; bottom: number[];
  turn: Seat; landlord: Seat | null; bids: {seat:Seat; score:number}[]; highestBid:number;
  last: {seat:Seat; cards:number[]; combo:Play} | null; passes:number;
  history: {seat:Seat; cards:number[]}[]; winner:Seat | null; redeals:number;
}
export const rank = (card:number):number => card >= 52 ? card - 36 : Math.floor(card / 4) + 3
export const cardName = (card:number):string => card === 52 ? '小王' : card === 53 ? '大王' :
  ['♠','♥','♣','♦'][card % 4] + (({11:'J',12:'Q',13:'K',14:'A',15:'2'} as Record<number,string>)[rank(card)] ?? String(rank(card)))
const sort = (cards:number[]) => [...cards].sort((a,b)=>rank(a)-rank(b)||a-b)
const runs = (values:number[]):boolean => values.length>0 && values.at(-1)! <= 14 && values.every((r,i)=>i===0 || r===values[i-1]!+1)
function groups(cards:number[]):Map<number,number[]> {
  const g=new Map<number,number[]>(); for(const c of sort(cards)){const r=rank(c);g.set(r,[...(g.get(r)??[]),c]);} return g
}
export function classify(cards:number[]):Play|null {
  if(!cards.length || cards.some(c=>!Number.isInteger(c)||c<0||c>53)||new Set(cards).size!==cards.length)return null
  const g=groups(cards), entries=[...g], n=cards.length;
  const match=(kind:string,high:number,chain=1):Play=>({kind,high,chain,length:n})
  if(n===2&&g.has(16)&&g.has(17))return match('rocket',17)
  if(entries.length===1){const r=entries[0]![0];return n<=4?match(['','single','pair','triple','bomb'][n]!,r):null}
  const triple=entries.find(([,v])=>v.length===3),four=entries.find(([,v])=>v.length===4)
  if(n===4&&triple)return match('triple-single',triple[0])
  if(n===5&&triple&&entries.some(([,v])=>v.length===2))return match('triple-pair',triple[0])
  if(n===6&&four)return match('four-two-single',four[0])
  if(n===8&&four&&entries.length===3&&entries.filter(([,v])=>v.length===2).length===2)return match('four-two-pair',four[0])
  const rs=[...g.keys()]
  if(n>=5&&entries.every(([,v])=>v.length===1)&&runs(rs))return match('straight',rs.at(-1)!,rs.length)
  if(n>=6&&n%2===0&&entries.every(([,v])=>v.length===2)&&runs(rs))return match('pair-straight',rs.at(-1)!,rs.length)
  // Plane wings may contain a pair as two singles, but cannot reuse a core rank or form a rocket.
  for(const unit of [3,4,5]){
    if(n%unit!==0||n/unit<2)continue;const k=n/unit
    const cores=entries.filter(([r,v])=>r<=14&&v.length>=3).map(([r])=>r)
    for(let i=0;i<=cores.length-k;i++){
      const core=cores.slice(i,i+k);if(!runs(core))continue
      const rest=entries.filter(([r])=>!core.includes(r));const leftover=rest.reduce((s,[,v])=>s+v.length,0)
      if(core.some(r=>g.get(r)!.length!==3))continue
      if(unit===3&&leftover===0)return match('plane',core.at(-1)!,k)
      if(unit===4&&leftover===k&&!(rest.some(([r])=>r===16)&&rest.some(([r])=>r===17)))return match('plane-single',core.at(-1)!,k)
      if(unit===5&&rest.length===k&&rest.every(([,v])=>v.length===2))return match('plane-pair',core.at(-1)!,k)
    }
  }
  return null
}
export function beats(next:Play, previous:Play|null):boolean {
  if(!previous)return true
  if(next.kind==='rocket')return previous.kind!=='rocket'
  if(previous.kind==='rocket')return false
  if(next.kind==='bomb'&&previous.kind!=='bomb')return true
  return next.kind===previous.kind&&next.length===previous.length&&next.chain===previous.chain&&next.high>previous.high
}
export function createLandlordGame(random:()=>number=Math.random,redeals=0):LandlordState {
  const deck=Array.from({length:54},(_,i)=>i)
  for(let i=53;i>0;i--){const j=Math.floor(random()*(i+1));[deck[i],deck[j]]=[deck[j]!,deck[i]!];}
  return {revision:0,phase:'bidding',hands:[sort(deck.slice(0,17)),sort(deck.slice(17,34)),sort(deck.slice(34,51))],bottom:sort(deck.slice(51)),
    turn:0,landlord:null,bids:[],highestBid:0,last:null,passes:0,history:[],winner:null,redeals}
}
function select<T>(items:T[],count:number,limit=80):T[][] {
  const result:T[][]=[]
  function walk(at:number,selected:T[]){if(result.length>=limit)return;if(selected.length===count){result.push(selected);return}
    for(let i=at;i<=items.length-(count-selected.length);i++)walk(i+1,[...selected,items[i]!]);}
  walk(0,[]);return result
}
/** Candidate generation consults only the current hand and public last play, never opponents' hands. */
export function legalMoves(hand:number[],last:Play|null):Move[] {
  const found=new Map<string,Move>(),g=groups(hand),entries=[...g]
  const add=(cards:number[])=>{const sorted=sort(cards),combo=classify(sorted);if(!combo||!beats(combo,last))return
    const key=sorted.join(',');found.set(key,{cards:sorted,label:`${combo.kind} · ${sorted.map(cardName).join(' ')}`});}
  for(const [,v] of entries){for(let n=1;n<=Math.min(v.length,4);n++)add(v.slice(0,n))}
  if(g.has(16)&&g.has(17))add([52,53])
  for(const [r,v] of entries){
    const others=entries.filter(([s])=>s!==r)
    if(v.length>=3)for(const [,w] of others){add([...v.slice(0,3),w[0]!]);if(w.length>=2)add([...v.slice(0,3),...w.slice(0,2)])}
    if(v.length===4){for(const wings of select(others.flatMap(([,w])=>w),2))add([...v,...wings]);for(const wings of select(others.filter(([,w])=>w.length>=2),2))add([...v,...wings.flatMap(([,w])=>w.slice(0,2))])}
  }
  for(const width of [1,2,3]){
    const rs=entries.filter(([r,v])=>r<=14&&v.length>=width).map(([r])=>r),minimum=width===1?5:width===2?3:2
    for(let start=0;start<rs.length;start++)for(let len=minimum;start+len<=rs.length;len++){
      const core=rs.slice(start,start+len);if(!runs(core))break
      const body=core.flatMap(r=>g.get(r)!.slice(0,width));add(body)
      if(width===3){const others=entries.filter(([r])=>!core.includes(r))
        for(const wings of select(others.flatMap(([,w])=>w),len,20))add([...body,...wings])
        for(const wings of select(others.filter(([,w])=>w.length>=2),len,20))add([...body,...wings.flatMap(([,w])=>w.slice(0,2))])}
    }
  }
  // Keep a bounded prompt. Prioritize shedding cards; retain pass as an explicit legal response.
  const moves=[...found.values()].sort((a,b)=>b.cards.length-a.cards.length||(classify(a.cards)!.high-classify(b.cards)!.high)).slice(0,96)
  if(last)moves.push({cards:[],label:'不出'})
  return moves
}
export function applyLandlordAction(state:LandlordState,seat:Seat,action:{bid?:number|undefined;cards?:number[]|undefined}):void {
  if(state.phase==='finished'||seat!==state.turn)throw new Error('未轮到该座位')
  if(state.phase==='bidding'){
    const score=action.bid;if(!Number.isInteger(score)||score!<0||score!>3||(score!==0&&score!<=state.highestBid))throw new Error('叫分必须为 0 或高于当前叫分的 1–3')
    state.bids.push({seat,score:score!});state.highestBid=Math.max(state.highestBid,score!)
    if(score===3||state.bids.length===3){
      if(state.highestBid===0){const fresh=createLandlordGame(Math.random,state.redeals+1);fresh.revision=state.revision+1;Object.assign(state,fresh);return}
      state.landlord=state.bids.find(b=>b.score===state.highestBid)!.seat;state.hands[state.landlord]=sort([...state.hands[state.landlord]!,...state.bottom]);state.turn=state.landlord;state.phase='playing'
    }else state.turn=((seat+1)%3) as Seat
  }else{
    const cards=action.cards;if(!Array.isArray(cards))throw new Error('缺少出牌')
    if(cards.length===0){if(!state.last||state.last.seat===seat)throw new Error('领出时不能不出');state.passes++;state.history.push({seat,cards:[]})
      if(state.passes===2){state.turn=state.last.seat;state.last=null;state.passes=0}else state.turn=((seat+1)%3) as Seat
    }else{
      if(new Set(cards).size!==cards.length||cards.some(c=>!state.hands[seat]!.includes(c)))throw new Error('不能出不属于自己的牌')
      const combo=classify(cards);if(!combo||!beats(combo,state.last?.combo??null))throw new Error('牌型不合法或未压过上一手')
      state.hands[seat]=state.hands[seat]!.filter(c=>!cards.includes(c));state.last={seat,cards:sort(cards),combo};state.history.push({seat,cards:sort(cards)});state.passes=0
      if(state.hands[seat]!.length===0){state.winner=seat;state.phase='finished'}else state.turn=((seat+1)%3) as Seat
    }
  }
  state.revision++
}
/** The sole information boundary for human UI, model prompts and local fallback policy. No state spread. */
export function landlordSeatView(state:LandlordState,seat:Seat) {
  const isTurn=state.turn===seat&&state.phase!=='finished'
  return {revision:state.revision,phase:state.phase,seat,turn:state.turn,landlord:state.landlord,
    ownHand:[...state.hands[seat]!],bottomCards:state.landlord===null?[]:[...state.bottom],
    bids:state.bids.map(b=>({...b})),highestBid:state.highestBid,
    history:state.history.map(p=>({seat:p.seat,cards:[...p.cards]})),
    remainingCounts:state.hands.map(h=>h.length),
    last:state.last?{seat:state.last.seat,cards:[...state.last.cards],combo:{...state.last.combo}}:null,
    legalBids:isTurn&&state.phase==='bidding'?[0,1,2,3].filter(n=>n===0||n>state.highestBid):[],
    legalMoves:isTurn&&state.phase==='playing'?legalMoves(state.hands[seat]!,state.last?.combo??null):[],
    winner:state.winner,winningSide:state.winner===null?null:state.winner===state.landlord?'landlord':'farmers',redeals:state.redeals}
}
export type LandlordView = ReturnType<typeof landlordSeatView>
export function localLandlordDecision(view:LandlordView):{bid?:number;cards?:number[]} {
  if(view.phase==='bidding'){
    const strength=view.ownHand.filter(c=>rank(c)>=15).length
    return {bid:strength>=3?(view.legalBids.at(-1)??0):0}
  }
  const teammateLeading=view.landlord!==view.seat&&view.last&&view.last.seat!==view.landlord
  const move=teammateLeading?view.legalMoves.find(m=>m.cards.length===0):view.legalMoves[0]
  if(!move)throw new Error('没有合法动作');return {cards:[...move.cards]}
}
