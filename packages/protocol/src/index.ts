/**
 * @dsh-gamecenter/protocol —— DSH 游戏中心共享协议的唯一来源。
 *
 * 重要：本包中的所有接口、错误码、schemaVersion 都是【拟新增协议】，
 * 除 `dshVersions.ts` 记录的 DSH 已安装版本事实外，**不是 DSH 既有 API**。
 * 唯一设计基线：docs/gamecenter-design.zh-CN.md。
 */

export type { JsonPrimitive, JsonValue, JsonObject } from './json.js'

export {
  MANIFEST_SCHEMA_VERSION,
  CATALOG_ENTRY_SCHEMA_VERSION,
  SAVE_FORMAT_VERSION,
  GAME_STATE_SCHEMA_VERSION,
  SDK_MAJOR_VERSION,
  SDK_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_MESSAGES,
  CATALOG_MAX_ISSUE_BODY_BYTES,
  parseSemver,
  sdkRangeAccepts,
} from './version.js'

export {
  ERROR_CODES,
  DEFAULT_RETRYABLE,
  isErrorCode,
  protocolError,
  type ErrorCode,
  type ProtocolError,
} from './errors.js'

export {
  AI_OPERATIONS,
  MODALITIES,
  satisfies,
  missingCapabilities,
  type AIOperation,
  type Modality,
  type CapabilityStatus,
  type CapabilityEvidence,
  type CapabilityQuery,
  type ModelLimits,
  type ModelCapabilityEntry,
  type SlotMatch,
} from './capabilities.js'

export {
  GAME_ID_PATTERN,
  isValidGameId,
  type GameManifestV1,
  type ManifestAiSlot,
} from './manifest.js'

export {
  DIGEST_PATTERN,
  COMMIT_PATTERN,
  isDigest,
  isFullCommit,
  catalogSourceKeyString,
  matchApproval,
  type CatalogSourceKey,
  type CatalogReleaseRef,
  type CatalogMachineEntry,
  type ApprovedRelease,
  type CatalogEntryView,
  type CatalogDisplayText,
} from './catalog.js'

export {
  AI_OPERATION_STATES,
  AI_OPERATION_TRANSITIONS,
  canTransition,
  checkSaveCompatibility,
  type SaveStatus,
  type ModelBinding,
  type GameSaveV1,
  type AiOperationState,
  type AiOperationRecord,
  type RuntimeLease,
  type SaveCompatibility,
} from './save.js'

export {
  BRIDGE_METHODS,
  utf8ByteLength,
  type BridgeMethod,
  type GameMessage,
  type AiGenerateRequest,
  type AiGenerateResult,
  type InboundEnvelope,
  type OutboundEnvelope,
  type HandshakeRequest,
  type HandshakeResponse,
} from './bridge.js'

export {
  DSH_VERSION_LOCK,
  DSH_ENGINES_RANGE,
  type DshVersionLock,
} from './dshVersions.js'
