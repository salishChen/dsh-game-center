import type {DshLlmLike} from '../dsh-adapter/context.js'
import type {AiModelBinding} from '@dsh-gamecenter/protocol'
import type {LandlordView} from '../games/landlord-engine.js'
import {tokenUsage, type LandlordCallTrace} from '../games/landlord-review.js'
import {AI_TIMEOUT_MS, AI_OUTPUT_MAX_BYTES} from './board-broker.js'

const INSTRUCTION='Play three-player Dou Dizhu from this seat only. You see your own hand, the public bottom cards only after bidding, and public bids/plays/counts. Card ids 0..51 use rank=floor(id/4)+3 (3..10,J=11,Q=12,K=13,A=14,2=15), suit=id%4 in spades/hearts/clubs/diamonds order. Card 52 is the small joker (rank 16); card 53 is the big joker (rank 17). Opponents hidden hands and undealt bottom cards are unavailable. Never claim to know them. Choose a legal bid as {"bid":number} during bidding or a zero-based entry in legalMoves as {"moveId":number} during play. Farmer teammates win together; landlord wins alone. You MUST select your legal bid or play within 5 seconds of receiving this message. Decide immediately using the provided legal options; keep deliberation brief. Return ONLY that JSON object, no reasoning, tools or other fields.'

/** Receives an already-redacted seat view, never a LandlordState or a cross-seat conversation. */
export async function generateLandlordDecision(llm:DshLlmLike|undefined,binding:AiModelBinding,view:LandlordView,signal?:AbortSignal,report?:(trace:Pick<LandlordCallTrace,'prompt'|'response'|'binding'|'elapsedMs'|'usage'|'status'|'error'>)=>void) {
  const start=Date.now(),controller=new AbortController()
  const abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
  let timer:ReturnType<typeof setTimeout>|undefined
  const cancelled=new Promise<never>((_,reject)=>{
    const fail=()=>reject(Object.assign(new Error(controller.signal.reason==='AI_TIMEOUT'?'模型请求超过 120 秒':'对局请求已取消'),{name:'AbortError'}))
    controller.signal.addEventListener('abort',fail,{once:true});if(controller.signal.aborted)fail()
    timer=setTimeout(()=>controller.abort('AI_TIMEOUT'),AI_TIMEOUT_MS)
  })
  let text='',usage:unknown,actual:AiModelBinding|undefined,prompt='',sealed=false,status:'success'|'failed'|'cancelled'='failed',error:string|undefined
  const execute=async()=>{
    const instruction=INSTRUCTION
    prompt=instruction+'\n'+JSON.stringify(view)
    if(controller.signal.aborted)throw Object.assign(new Error('已取消'),{name:'AbortError'})
    if(!llm?.prepareCall)throw new Error('模型执行适配器未就绪')
    const prepared=await llm.prepareCall!({provider:binding.providerId,model:binding.modelId,...(binding.reasoningEffort?{reasoningEffort:binding.reasoningEffort}:{})},controller.signal)
    if(sealed||controller.signal.aborted)throw Object.assign(new Error('已取消'),{name:'AbortError'})
    actual={providerId:prepared.config.provider,modelId:prepared.config.model,...(prepared.config.reasoningEffort?{reasoningEffort:prepared.config.reasoningEffort}:{})}
    let finished=false
    // Build a fresh request per decision. No transcripts or reasoning are shared between seats.
    for await(const chunk of prepared.stream({...prepared.config,tools:[],messages:[{id:`landlord-${view.revision}-${view.seat}-${start}`,source:{kind:'plugin',plugin:'@dsh-gamecenter/host'},role:'user',content:[{type:'text',text:prompt}]}],signal:controller.signal})){
      if(sealed||controller.signal.aborted)throw Object.assign(new Error('已取消'),{name:'AbortError'})
      if(chunk.type==='text-delta')text+=chunk.text??''
      if(chunk.type==='usage')usage={...tokenUsage(usage),...tokenUsage(chunk.usage)}
      if(new TextEncoder().encode(text).byteLength>AI_OUTPUT_MAX_BYTES){controller.abort('OUTPUT_TOO_LARGE');throw new Error('模型输出超限')}
      if(chunk.type==='finish'){const reason=chunk.reason as any;if((typeof reason==='string'?reason:reason?.kind)!=='stop')throw new Error('模型未正常完成');finished=true}
    }
    if(!finished)throw new Error('模型未完成回复')
    const parsed=JSON.parse(text.trim()) as Record<string,unknown>
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).length!==1)throw new Error('模型动作格式不合法')
    let action:{bid?:number;cards?:number[]}
    if(view.phase==='bidding'){
      if(!Number.isInteger(parsed.bid)||!view.legalBids.includes(parsed.bid as number))throw new Error('模型叫分不合法')
      action={bid:parsed.bid as number}
    }else{
      if(!Number.isInteger(parsed.moveId)||!(parsed.moveId as number>=0)||!view.legalMoves[parsed.moveId as number])throw new Error('模型出牌不合法')
      action={cards:[...view.legalMoves[parsed.moveId as number]!.cards]}
    }
    return {action,binding:actual,elapsedMs:Date.now()-start,...(usage===undefined?{}:{usage:tokenUsage(usage)})}
  }
  try{const result=await Promise.race([execute(),cancelled]);status='success';return result}
  catch(e){status=signal?.aborted?'cancelled':'failed';error=e instanceof Error?e.message:'模型失败';throw e}
  finally{sealed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);report?.({prompt,response:text,...(actual?{binding:actual}:{}),elapsedMs:Date.now()-start,usage:tokenUsage(usage),status,...(error?{error}:{})})}
}
