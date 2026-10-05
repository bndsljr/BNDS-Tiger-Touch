/**
 * Titan 16 WebAPI 客户端。
 *
 * 公开入口。设计原则：**把已核实的陷阱编码进类型与默认行为**，
 * 而不是留给调用者记住。
 */

export { TitanClient, type TitanClientOptions, type TitanResponse } from './client.ts';

export {
  HANDLE_GROUPS,
  UNVERIFIED_HANDLE_GROUPS,
  encodeHandle,
  encodeHandleList,
  encodeAmbiguousHandleUserNumber,
  TitanAddressError,
  type HandleGroup,
  type HandleRef,
  type LocationRef,
} from './handles.ts';

export {
  encodeParams,
  level,
  levelDelta,
  handle,
  handleList,
  DEFAULT_ENCODING,
  TitanParamError,
  type EncodingOptions,
  type LevelAdjust,
  type ParamValue,
} from './params.ts';

export {
  FRAME_RATES,
  formatTimecodeTime,
  msToTimecode,
  parseTimecodeTime,
  timecodeToMs,
  TitanTimecodeError,
  type FrameRateName,
  type TimecodeParts,
} from './timecode.ts';

export {
  TitanConsoleError,
  TitanHttpError,
  TitanTimeoutError,
  TitanUnreachableError,
  TitanVersionMismatchError,
  detectConsoleError,
} from './errors.ts';

export {
  METHOD_SUBSTITUTIONS,
  MEDIUM_CONFIDENCE_TYPES,
  findSubstitution,
  type Substitution,
} from './substitutions.ts';

export { diagnose, type DiagnosticCheck, type DiagnosticReport } from './diagnostics.ts';
export { Playbacks, type PlaybackSummary } from './providers/playbacks.ts';
export { Handles } from './providers/handles.ts';
export {
  ShowReader,
  secondsToMs,
  type CueInfo,
  type FixtureInfo,
  type GroupInfo,
  type PaletteInfo,
  type PlaybackInfo,
  type ReadInventoryOptions,
  type ShowInventory,
} from './providers/showreader.ts';
