import type {AiModelBinding} from '@dsh-gamecenter/protocol'

export interface TokenUsage {
  inputTokens?:number; outputTokens?:number; totalTokens?:number
  cacheReadTokens?:number; cacheWriteTokens?:number; reasoningTokens?:number
}
/** Only DSH's documented counters, never provider metadata or credentials. Snapshots are cumulative. */
export function tokenUsage(raw:unknown):TokenUsage {
  const result:TokenUsage={}
  if(!raw||typeof raw!=='object')return result
  for(const key of ['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens'] as const){
    const n=(raw as Record<string,unknown>)[key]
    if(typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)result[key]=n
  }
  return result
}
export interface LandlordCallTrace {
  operationId:string; seat:number; revision:number; startedAt:string
  requestedBinding?:AiModelBinding; binding?:AiModelBinding
  prompt?:string; response?:string; elapsedMs:number; usage:TokenUsage
  status:'success'|'failed'|'cancelled'|'local'; source:'ai'|'local'|'none'
  error?:string; action?:{bid?:number;cards?:number[]}
}
export function summarizeCalls(calls:LandlordCallTrace[]) {
  const modelCalls=calls.filter(c=>c.requestedBinding)
  const totals:TokenUsage={},reportedCalls:Record<string,number>={}
  for(const call of modelCalls)for(const [key,n] of Object.entries(call.usage)){
    const k=key as keyof TokenUsage
    totals[k]=(totals[k]??0)+n;reportedCalls[k]=(reportedCalls[k]??0)+1
  }
  // Do not add cache/reasoning counters to the reported total: provider accounting differs.
  return {modelCalls:modelCalls.length,localDecisions:calls.filter(c=>c.source==='local').length,totals,reportedCalls}
}
