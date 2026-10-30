// @ts-check
// @ts-expect-error supplied by DSH
import {createElement as h,useEffect,useRef,useState} from 'react';
import {ARENA_PERSONAS,arenaModelPersona} from '@dsh-gamecenter/protocol';
import {ArenaPortrait} from './ArenaPortrait.js';

/** Platform-owned binding UI: the iframe can never inject provider credentials or claim a model.
 * @param {{session:any,getService:()=>any,onSelected:()=>void,onExit:()=>void}} props */
export function ArenaOpponentPicker({session,getService,onSelected,onExit}){
  const ref=useRef(/** @type {HTMLDialogElement|null} */(null));
  const [models,setModels]=useState(/** @type {any[]} */([])),[loading,setLoading]=useState(true),[error,setError]=useState(''),[family,setFamily]=useState(''),[modelKey,setModelKey]=useState(''),[effort,setEffort]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{ref.current?.showModal();const node=ref.current;return()=>node?.close();},[]);
  useEffect(()=>{let live=true;void Promise.resolve().then(async()=>{const result=await getService()?.modelCatalog();if(!result?.available)throw Error('DSH 模型目录尚未就绪');if(live)setModels(result.entries??[]);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[getService]);
  const available=models.filter((/** @type {any} */ entry)=>arenaModelPersona(entry)===family),selected=available.find((/** @type {any} */ m)=>JSON.stringify([m.providerId,m.modelId])===modelKey);
  /** @param {string} id */
  function chooseFamily(id){const choices=models.filter((/** @type {any} */ entry)=>arenaModelPersona(entry)===id),next=choices[0];setFamily(id);setModelKey(next?JSON.stringify([next.providerId,next.modelId]):'');setEffort(next?.reasoning?.defaultEffort??'');setError('');}
  async function confirm(){
    if(!selected||busy)return;setBusy(true);setError('');
    try{const result=await getService()?.setAiBinding({runtimeToken:session.runtimeToken,slot:'vehicleBuild',providerId:selected.providerId,modelId:selected.modelId,...(effort?{reasoningEffort:effort}:{})});if(!result?.ok)throw Error(result?.message||'模型绑定未确认');
      session.aiBindings||={};session.aiBindings.vehicleBuild=result.binding;session.arenaOpponent={familyId:family,name:ARENA_PERSONAS.find(p=>p.id===family)?.name,binding:result.binding};onSelected();
    }catch(e){setError(/** @type {any} */(e).message);}finally{setBusy(false);}
  }
  return h('dialog',{ref,className:'gc-opponent-dialog','data-arena-opponent-picker':'',onCancel:(/** @type {any} */ event)=>event.preventDefault(),'aria-labelledby':'arena-opponent-title'},
    h('p',{className:'gc-overline'},'CHOOSE YOUR OPPONENT'),h('h2',{id:'arena-opponent-title'},'选择 AI 对手'),h('p',{className:'gc-opponent-intro'},'先选择角色与对应模型，再用同样的 300 金币打造战车。角色外观不提供战斗加成。'),
    loading&&h('p',{role:'status'},'正在读取 DSH 已配置模型…'),
    h('div',{className:'gc-opponent-grid'},...ARENA_PERSONAS.map(persona=>{const count=models.filter((/** @type {any} */ m)=>arenaModelPersona(m)===persona.id).length;return h('button',{key:persona.id,type:'button','data-arena-opponent':persona.id,className:family===persona.id?'gc-opponent-card is-selected':'gc-opponent-card',disabled:loading||busy||!count,'aria-pressed':family===persona.id,onClick:()=>chooseFamily(persona.id)},h(ArenaPortrait,{personaId:persona.id}),h('strong',{},persona.name),h('span',{},persona.model),h('small',{},count?`${count} 个已配置模型`:'尚未配置模型'));})),
    family&&h('div',{className:'gc-opponent-config'},h('label',{},'具体模型',h('select',{'aria-label':'对手模型',value:modelKey,disabled:busy,onChange:(/** @type {any} */ event)=>{const key=event.target.value,next=available.find((/** @type {any} */ m)=>JSON.stringify([m.providerId,m.modelId])===key);setModelKey(key);setEffort(next?.reasoning?.defaultEffort??'');}},...available.map((/** @type {any} */ m)=>h('option',{key:JSON.stringify([m.providerId,m.modelId]),value:JSON.stringify([m.providerId,m.modelId])},`${m.name||m.modelId} · ${m.providerId}`)))),h('label',{},'推理水平',h('select',{'aria-label':'对手推理水平',value:effort,disabled:busy,onChange:(/** @type {any} */ e)=>setEffort(e.target.value)},h('option',{value:''},'提供方默认'),...(selected?.reasoning?.efforts??[]).map((/** @type {any} */ e)=>h('option',{key:e.id,value:e.id},e.name))))),
    !loading&&!models.some((/** @type {any} */ m)=>arenaModelPersona(m))&&h('p',{},'请先在 DSH 模型设置中配置这些系列的模型，再重新进入 AI 对战。'),
    error&&h('p',{role:'alert',className:'gc-opponent-error'},error),h('div',{className:'gc-opponent-actions'},h('button',{type:'button',className:'gc-button',disabled:busy,onClick:onExit},'返回游戏库'),h('button',{type:'button',className:'gc-button gc-play',disabled:!selected||busy,onClick:()=>void confirm()},busy?'正在绑定…':'确认对手 · 进入工坊')),
  );
}
