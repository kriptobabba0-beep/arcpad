/**
 * MINIMUM ABI'LER, ELLE YAZILDI -- `src/watch/graduationWindow.ts`in
 * `FACTORY_WATCH_ABI`si ile AYNI GEREKCE: keeper'in testleri bir Solidity
 * derleyicisi gerektirmemelidir ve `contracts/out/` baska bir surecin cikti
 * dizinidir.
 *
 * NEDEN `packages/shared`'IN `bondingCurveAbi`SI DEGIL. Curve tarafi icin o
 * paket zaten yeterdi, ama `ArcpadLocker` ORADA YOKTUR: `ARCPAD_ERROR_ABI`
 * yalnizca `BondingCurve`, `LaunchFactory`, `LaunchToken`, `FeeEscrow` ve
 * `CurveMath`tan derlenir ve `packages/shared/test/abi-parity.test.ts` o
 * listeyi `forge build` ciktisina karsi kapitir. Locker'i oraya eklemek
 * paylasilan bir paketi ve onun parity kapisini degistirmek demekti; bu gorev
 * `keeper/` sahibidir, o yuzden yuzey BURADA, DAR ve locker'a ozgu tutulur.
 * Ayrisma riskinin mercii, zincire karsi kosan `graduate --once` ve
 * `Surface.t.sol`dur.
 */

/** `ArcpadLocker`, keeper'in dokundugu kadari. */
export const LOCKER_ABI = [
  {
    type: 'function',
    name: 'graduate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'curve', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'factory',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  { type: 'error', name: 'NotPoolManager', inputs: [] },
  { type: 'error', name: 'CurveNotFromFactory', inputs: [] },
  { type: 'error', name: 'UnexpectedCredit', inputs: [] },
  { type: 'error', name: 'SeedShortfall', inputs: [] },
  { type: 'error', name: 'ZeroLiquidity', inputs: [] },
  { type: 'error', name: 'PoolPriceMismatch', inputs: [] },
  { type: 'error', name: 'PositionNotSeeded', inputs: [] },
] as const

/**
 * `BondingCurve`in HATALARI, ve YALNIZCA hatalari.
 *
 * UC GETTER (`complete`, `graduated`, `realQuoteReserves`) BURADA BILEREK
 * YOKTUR: onlari okuyan tek yol `src/watch/graduationWindow.ts`teki
 * `scanCurveStates`tir ve "tamamlanmis ama mezun edilmemis" predikati de
 * orada, TEK bir yerde yasar. Ikinci bir okuma yolu acmak, iki tuketicinin
 * (pencere izleyicisi ve bu yurutucu) AYRISABILECEGI bir pencere yaratirdi --
 * bu deponun birinci arıza kipi.
 *
 * `Completed` olayi da yoktur, ve yoklugu ayni karardir: curve kumesi
 * `Launched`dan kurulur, graduation kararini ise SLOT verir. Slot logdan daha
 * gunceldir ve -- bu gorev icin belirleyici olan -- keeper'in KAPALI oldugu
 * sureden etkilenmez.
 */
export const CURVE_ERROR_ABI = [
  { type: 'error', name: 'NotComplete', inputs: [] },
  { type: 'error', name: 'AlreadyGraduated', inputs: [] },
  { type: 'error', name: 'GraduationTargetUnset', inputs: [] },
  { type: 'error', name: 'NotGraduationTarget', inputs: [] },
  { type: 'error', name: 'GraduationPayoutFailed', inputs: [] },
  { type: 'error', name: 'TokenTransferFailed', inputs: [] },
  { type: 'error', name: 'CurveComplete', inputs: [] },
] as const

/** `LaunchFactory`, yalnizca yurutucunun ihtiyaci olan iki uye. */
export const FACTORY_ABI = [
  {
    type: 'function',
    name: 'graduationTarget',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'launchCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const
