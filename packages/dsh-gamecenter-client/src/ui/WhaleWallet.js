// @ts-check
// @ts-expect-error supplied by DSH
import {createElement as h,useEffect,useState} from 'react';
/** @param {{getService:()=>any}} props */
export function WhaleWallet({getService}) {
  const [status,setStatus]=useState(/** @type {any} */ (null)),[error,setError]=useState('');
  useEffect(()=>{
    let live=true;
    const refresh=async()=>{try{const service=getService();if(!service?.walletStatus)throw Error('钱包服务尚未加载');const result=await service.walletStatus({});if(!result.ok)throw Error(result.message);if(live){setStatus(result.wallet);setError('');}}catch(e){if(live)setError(e instanceof Error?e.message:'钱包读取失败');}};
    void refresh();const timer=setInterval(refresh,15000);window.addEventListener('focus',refresh);window.addEventListener('gamecenter:wallet-updated',refresh);
    return ()=>{live=false;clearInterval(timer);window.removeEventListener('focus',refresh);window.removeEventListener('gamecenter:wallet-updated',refresh);};
  },[getService]);
  return h('details',{'data-whale-wallet':'',className:'gc-wallet'},
    h('summary',{'aria-label':`鲸鲸币 ${status?status.balance:'加载中'}，查看明细`},h('span',{className:'gc-wallet-symbol','aria-hidden':'true'},'◈'),h('span',{className:'gc-wallet-name'},'鲸鲸币'),h('strong',{role:'status'},status?status.balance.toLocaleString():'—'),h('span',{className:'gc-wallet-chevron','aria-hidden':'true'},'▾')),
    h('div',{className:'gc-wallet-info'},
    h('p',{},status?`当前 profile 累计已报告 ${status.totalTokens.toLocaleString()} Token`:'正在读取钱包'),
    h('p',{},status?.history?.status==='completed'?`首次补发已计入 ${status.history.tokens.toLocaleString()} Token`:status?.history?.status==='scanning'?`首次补发：${status.history.scannedSessions} / ${status.history.totalSessions} 个会话`:status?.history?.status==='failed'?'首次补发读取失败，将自动重试':status?.history?.status==='legacy-unverified'?'旧账本缺少边界，补发需核对':'首次补发等待 DSH 历史服务'),
    h('p',{},error||(!status?'正在读取钱包':!status.meterActive?'Token 记账未接通':`每 100 万 Token +10 · 距下次 ${status.nextRewardIn.toLocaleString()} Token`)),
    h('p',{},'首次启用补发之前 30 天，后续实时累计。未报告总量的调用不估算。支持的游戏可按 1 鲸鲸币 = 10 金币兑换。')),
  );
}
