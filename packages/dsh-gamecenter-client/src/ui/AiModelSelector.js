// @ts-check
// @ts-expect-error DSH supplies React at runtime.
import { createElement as h, useEffect, useState } from 'react';

const SELECT_STYLE = {
  font: 'inherit', color: 'var(--dsw-alias-label-primary, CanvasText)',
  background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, Canvas))',
  border: '1px solid var(--dsw-alias-border-l3, GrayText)', borderRadius: '4px',
  padding: '3px 6px', maxWidth: '100%',
};

/** @param {{session: any, slot?:string, getService: () => any, onChange: () => void}} props */
export function AiModelSelector({session, slot='boardGeneration', getService, onChange}) {
  const binding = session.aiBindings?.[slot] || (slot === 'boardGeneration' ? session.aiBinding : null);
  const [models, setModels] = useState(/** @type {any[]} */ ([]));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(binding ? JSON.stringify([binding.providerId, binding.modelId]) : '');
  const [effort, setEffort] = useState(binding?.reasoningEffort ?? '');
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      const result = await getService()?.modelCatalog();
      if (!active) return;
      if (!result?.available) throw new Error('模型目录不可用');
      setModels(result.entries ?? []);
    }).catch(e => { if (active) setError(String(e.message || e)); });
    return () => { active = false; };
  }, [session, getService]);
  const model = models.find((/** @type {any} */ m) => JSON.stringify([m.providerId, m.modelId]) === selected);
  /** @param {string} key @param {string | undefined} nextEffort */
  const bind = async (key, nextEffort) => {
    if (!key) return;
    setSaving(true); setError('');
    try {
      const [providerId, modelId] = JSON.parse(key);
      const result = await getService()?.setAiBinding({runtimeToken:session.runtimeToken, slot, providerId, modelId,
        ...(nextEffort ? {reasoningEffort:nextEffort} : {})});
      if (!result?.ok) throw new Error(result?.message || '模型绑定失败');
      session.aiBindings ||= {}; session.aiBindings[slot] = result.binding;
      if (slot === 'boardGeneration') session.aiBinding = result.binding;
      setSelected(key); setEffort(result.binding.reasoningEffort ?? ''); onChange();
    } catch (e) { setError(String(/** @type {any} */ (e).message || e)); }
    finally { setSaving(false); }
  };
  const disabled = saving || session.aiBusy === true;
  return h('div', {style:{display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap'}, 'data-gamecenter-ai-selector':''},
    h('label', null, slot.startsWith('landlordSeat') ? `电脑 ${slot.slice(-1)} 模型 ` : '模型 ', h('select', {style:SELECT_STYLE, value:selected, disabled, 'aria-label':slot.startsWith('landlordSeat') ? `电脑 ${slot.slice(-1)} 模型` : '生成模型', onChange:(/** @type {any} */ event) => {
      const key = event.target.value;
      const next = models.find((/** @type {any} */ m) => JSON.stringify([m.providerId,m.modelId]) === key);
      void bind(key, next?.reasoning?.defaultEffort);
    }}, h('option', {value:''}, '请选择模型'), ...models.map((/** @type {any} */ m) => h('option', {key:JSON.stringify([m.providerId,m.modelId]), value:JSON.stringify([m.providerId,m.modelId])}, `${m.providerId} / ${m.name || m.modelId}`)))),
    h('label', null, '推理水平 ', h('select', {style:SELECT_STYLE, value:effort, disabled:disabled || !selected, 'aria-label':'推理水平', onChange:(/** @type {any} */ event) => void bind(selected, event.target.value)},
      h('option', {value:''}, '提供方默认'), ...(model?.reasoning?.efforts ?? []).map((/** @type {any} */ value) => h('option',{key:value.id, value:value.id},value.name)))),
    h('span', {role:'status'}, session.aiBusy ? '电脑思考中…' : session.aiStatus || (slot==='vehicleBuild'?'选择 AI 对战模型，在游戏中锁定装配后生成':slot.startsWith('landlordSeat') ? '未绑定时使用本地策略' : '首击时生成；每局一次请求')),
    error ? h('span',{role:'alert',style:{color:'var(--dsw-alias-state-error-primary, #cf222e)'}},error) : null);
}
