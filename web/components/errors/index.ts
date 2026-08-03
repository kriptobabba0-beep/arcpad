/**
 * HATA YUZEYININ TEK KAPISI.
 *
 * Panel ve form tarafi buradan ucunu birden alir: `readFailure` cozucunun
 * ciktisini metne cevirir, `TxStatusRegion` kabuktaki tek duyuru bolgesidir,
 * `FailureNotice` da o bolgenin icine ya da bir panelin altina cizilir.
 * `reachableErrors` ise kimsenin cagirmadigi ama kapinin okudugu otoritedir.
 */
export { FailureNotice, describeRaw } from './FailureNotice'
export {
  type FailureContext,
  type FailureTone,
  readFailure,
  type ReadableFailure,
  resolveCellCopy,
  stillPendingFailure,
  wrongNetworkFailure,
} from './failureCopy'
export {
  CALL_PATH,
  ERROR_SURFACE,
  type ErrorReach,
  REACHABLE_BY_ACTION,
  SHADOWED_BY_GUARD,
  SOURCE_UNITS,
  type SurfaceCell,
  surfaceCell,
  surfaceKeys,
  surfaceNamesOf,
  TABLE_FIX_ADD,
  TABLE_FIX_REMOVE,
  TABLE_FIX_UNREACHABLE,
  type TableFix,
} from './reachableErrors'
export { arcScanTxUrl, TxStatus, type TxPhase } from './TxStatus'
export { TxStatusRegion } from './TxStatusRegion'
