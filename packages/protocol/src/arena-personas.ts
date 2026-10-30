export const ARENA_PERSONAS=[
  {id:'deepseek',name:'大肥鱼',model:'DeepSeek',characterId:'bulwark',color:'#78b9e8',cell:0},
  {id:'gemini',name:'双子',model:'Gemini',characterId:'rocketeer',color:'#b5a4fa',cell:1},
  {id:'claude',name:'克洛德',model:'Claude',characterId:'claw',color:'#e7aa79',cell:2},
  {id:'gpt',name:'小吉',model:'GPT',characterId:'dragon',color:'#c4cdf4',cell:3},
  {id:'glm',name:'智谱',model:'GLM',characterId:'spark',color:'#8da6d6',cell:4},
  {id:'qwen',name:'千问',model:'Qwen',characterId:'tinker',color:'#8aaef5',cell:5},
] as const
export type ArenaPersonaId=typeof ARENA_PERSONAS[number]['id']
/** Model identity takes precedence over an arbitrary provider/connection nickname. */
export function arenaModelPersona(entry:{providerId:string;modelId:string;name?:string}):ArenaPersonaId|null {
  const identify=(text:string):ArenaPersonaId|null=>{
    if(/deepseek|深度求索/i.test(text))return 'deepseek'
    if(/gemini|google|双子/i.test(text))return 'gemini'
    if(/claude|anthropic|克洛德/i.test(text))return 'claude'
    if(/(?:^|[^a-z])gpt(?:[^a-z]|$)|(?:^|[/:_ -])o[134](?:[-_/. ]|$)|openai/i.test(text))return 'gpt'
    if(/(?:^|[^a-z])glm(?:[^a-z]|$)|zhipu|智谱|z\.ai/i.test(text))return 'glm'
    if(/qwen|通义|千问|dashscope/i.test(text))return 'qwen'
    return null
  }
  return identify(entry.modelId)||identify(entry.name??'')||identify(entry.providerId)
}
