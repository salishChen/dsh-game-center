/**
 * 缂栬瘧鎬佹帰閽堬細楠岃瘉 Host 渚ф敼鐢?*鏍囧噯瑁呴グ鍣?*鍚庯紝鑳藉湪鏈粨搴撶湡瀹炵被鍨嬫鏌ラ€氳繃銆? *
 * 鐢ㄩ€旓細鍥炵瓟銆屾瀯寤烘€佹€庝箞鎷垮埌 @deepseek-ai/dsh-typert-protocol 鐨勭被鍨嬨€嶁€斺€? * 绛旀鏄敱鏍?devDependency 鎻愪緵**鐗堟湰瀵归綈**锛?.2.1-rc.2锛夌殑鐪熷疄鍖咃紝
 * 涓嶉厤 tsconfig paths銆佷笉鍐?ambient 鍋囧０鏄庛€? *
 * 妫€鏌ワ細node node_modules/typescript/lib/tsc.js --noEmit -p tools/cordis-inject-probe/tsconfig.probe.json
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

interface HandshakeInput {
  runtimeInstanceId: string
  nonce: string
  gameId: string
  gameVersion: string
  sdkVersion: string
  bridgeVersion: 1
}

interface HandshakeOutput {
  ok: boolean
  generation?: number
  runtimeToken?: string
}

/** 鍙敤浜庣紪璇戞€侀獙璇侊紝涓嶅弬涓庤繍琛屻€?*/
export class ProbeGameCenterService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'gameCenter', { namespace: 'gameCenter' })
  }

  @Remote
  handshake(input: HandshakeInput): HandshakeOutput {
    return { ok: input.bridgeVersion === 1 }
  }

  @Remote
  async modelCatalog(signal: AbortSignal): Promise<{ available: boolean }> {
    void signal
    return { available: false }
  }
}

