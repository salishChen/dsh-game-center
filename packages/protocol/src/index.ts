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
  CATALOG_MACHINE_FENCE,
  parseCatalogIssueBody,
  authorizeInstall,
  buildInstallPlan,
  isSafePathSegment,
  isSafeRelativePath,
  digestMatches,
  type CatalogParseResult,
  type CatalogParseOk,
  type InstallRejection,
  type InstallPlan,
  type InstallPlanResult,
} from './install.js'

export {
  CHECKPOINT_OPERATION_LOG_LIMIT,
  CHECKPOINT_OPERATION_ID_PATTERN,
  isValidCheckpointOperationId,
  decideCheckpoint,
  checkpointIdempotencyKey,
  canonicalCheckpointContent,
  encodeKeySegment,
  isValidIdentitySegment,
  saveStorageKey,
  type CheckpointRequest,
  type CheckpointResult,
  type CheckpointDecision,
  type CheckpointIdempotencyScope,
  type CheckpointContentInput,
} from './checkpoint.js'

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
  SAVE_SLOTS,
  isSaveIdShapeValid,
  LEASE_ACK_WINDOW_MS,
  LEASE_RECLAIM_REASONS,
  isLaunchTokenShapeValid,
  validateAbandonRuntimeRequest,
  utf8ByteLength,
  type BridgeMethod,
  type SaveSlot,
  type LeaseReclaimReason,
  type AbandonRuntimeRequest,
  type AbandonRuntimeResult,
  type WireViolationLike,
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

export {
  GAMECENTER_REMOTE_METHODS,
  GAMECENTER_REMOTE_METHOD_ADDITIONS,
  CATALOG_WIRE_SOURCES,
  CATALOG_APPROVAL_STATES,
  GAME_BUNDLE_MAX_FILES,
  GAME_BUNDLE_MAX_FILE_BYTES,
  GAME_BUNDLE_MAX_TOTAL_BYTES,
  GAME_BUNDLE_MAX_PATH_LENGTH,
  GAME_BUNDLE_TEXT_EXTENSIONS,
  GAME_IFRAME_SANDBOX,
  GAME_DOCUMENT_CSP,
  GAME_PREVIEW_LABEL,
  CHECKPOINT_WRITABLE_LEASE_STATES,
  PAUSE_FINALIZATION_ORDER,
  decideCheckpointAdmission,
  isPauseFinalizationOrderValid,
  type CheckpointWritableLeaseState,
  type CheckpointAdmissionLease,
  type CheckpointAdmissionResult,
  type PauseFinalizationStep,
  validateCatalogInstallRequest,
  validateSaveLatestRequest,
  validateSaveCheckpointRequest,
  validatePreviewBundleRequest,
  isSafeBundlePath,
  bundleContentBytes,
  validateGameBundleFiles,
  validateFramePolicy,
  type SaveCheckpointWireRequest,
  type SaveCheckpointWireResult,
  type PreviewListWireEntry,
  type PreviewListWireResult,
  type PreviewBundleWireRequest,
  type PreviewBundleWireResult,
  type GameCenterRemoteMethod,
  type GameCenterRemoteMethodAddition,
  type CatalogWireSource,
  type CatalogApprovalState,
  type CatalogListWireEntry,
  type CatalogListWireRequest,
  type CatalogListWireResult,
  type CatalogInstallWireRequest,
  type CatalogInstallWireResult,
  type GameBundleWireRequest,
  type GameBundleWireFile,
  type GameBundleWireResult,
  type SaveLatestWireRequest,
  type SaveLatestWireResult,
  type WireViolation,
} from './wiring.js'

export {
  METADATA_APPROVAL_ENABLED,
  CATALOG_METADATA_SCHEMA_VERSION,
  DESCRIPTION_MARKDOWN_MAX_CHARS,
  COVER_MAX_COUNT,
  SCREENSHOT_MAX_COUNT,
  MEDIA_MAX_BYTES_PER_IMAGE,
  MEDIA_MAX_EDGE_PX,
  MEDIA_ALLOWED_MIME,
  findMarkdownHazards,
  isAllowedMediaUrl,
  validateDisplayMetadata,
  canonicalMetadataJson,
  describeMetadataDigestInput,
  evaluateCompatibility,
  type MediaMime,
  type CatalogMediaRef,
  type CatalogCompatibility,
  type CatalogDisplayMetadata,
  type CatalogMetadataViolation,
  type CatalogTrustTuple,
} from './catalogMetadata.js'
