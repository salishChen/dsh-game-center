import type {JsonValue} from './json.js'

/** Wallet ownership comes from the Host profile, never from a game-supplied player id. */
export type WalletStatusRequest=Record<string,never>
export interface WhaleWalletStatus {
  history?:{status:string;from:number;to:number;tokens:number;calls:number;scannedSessions:number;totalSessions:number;error?:string}
  balance:number
  totalTokens:number
  nextRewardIn:number
  earned:number
  meterActive:boolean
  scope:string
  rate:{tokens:number;coins:number;goldPerCoin:number}
}
export interface WalletActionWireRequest {
  runtimeToken:string
  action:'status'|'saveGame'|'exchange'
  operationId?:string
  expectedRevision?:number
  amount?:number
  state?:JsonValue
}
export interface WalletActionWireResult {
  ok:boolean
  wallet?:WhaleWalletStatus
  revision?:number
  state?:JsonValue
  replayed?:boolean
  errorCode?:string
  message?:string
}
export interface WalletStatusResult {ok:true;wallet:WhaleWalletStatus}
