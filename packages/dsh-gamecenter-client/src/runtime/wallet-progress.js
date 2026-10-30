// @ts-check
/** Commit the Flash final scene before revoking its lease or destroying the iframe.
 * The runtime token stays in Client; Host still authenticates and validates every field.
 * @param {any} session @param {any} service @returns {Promise<boolean>} */
export async function saveFlashBeforeClose(session,service){
 if(session.gameId!=='example.crazy-flasher4')return false;
 if(!service?.walletAction||!session.dispatcher?.control)throw Error('游戏保存服务尚未就绪');
 const status=await service.leaseStatus({runtimeToken:session.runtimeToken});
 if(status?.state==='suspended'){
  const resumed=await service.resumeRuntime({runtimeToken:session.runtimeToken,generation:session.lease.generation});
  if(!resumed?.ok)throw Error('保存前未能恢复宿主租约');
 }
 if(!session.walletCloseRequest){
  const ack=await session.dispatcher.control('suspend');
  const snapshot=ack.snapshot;
  if(!snapshot?.progress)return false;
  if(snapshot.pending)throw Error('充值或保存请求尚未确认，请先重试确认结果后关闭');
  if(!Number.isSafeInteger(snapshot.walletRevision)||snapshot.walletRevision<0)throw Error('游戏存档版本不合法');
  session.walletCloseRequest={action:'saveGame',operationId:`cf4-close:${crypto.randomUUID()}`,expectedRevision:snapshot.walletRevision,state:structuredClone(snapshot.progress)};
 }
 const result=await service.walletAction({...session.walletCloseRequest,runtimeToken:session.runtimeToken});
 if(!result?.ok)throw Error(result?.message||'保存未确认，游戏仍保留');
 return true;
}
