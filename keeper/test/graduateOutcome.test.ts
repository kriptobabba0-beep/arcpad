import { describe, expect, it } from 'vitest'
import {
  assertSelectorsAgree,
  CHAIN_ERRORS_BEFORE_PAGE,
  chainErrorClassification,
  classifyRevert,
  MEASURED_SELECTORS,
} from '../src/graduate/outcome'

/**
 * ============ BU DOSYA CANLI BIR OLCUMDEN DOGDU ============
 *
 * 2026-08-09, `https://rpc.testnet.arc.network`, blok 56029795, uretim
 * locker'i `0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8`:
 *
 *   cast call <locker> 'graduate(address)' 0xDdB9e739a948c968eB4C7E1449B94C598B1cf27B
 *     -> execution reverted, data: "0xfe30fa5b"       (GraduationTargetUnset)
 *   cast call <locker> 'graduate(address)' 0x53Bba88F1b9897A8B61c860E9E7413ca1a1644c9
 *     -> execution reverted, data: "0x0701727f"       (NotComplete)
 *
 * Birincisi UYANDIRMAMALI: uretim fabrikasinin `graduationTarget`i BUGUN
 * `0x0`dir ve OYLE KALMALIDIR.
 *
 * SELECTOR'LAR BURADA LITERAL YAZILIR, `MEASURED_SELECTORS`TEN OKUNMAZ.
 * `chainReader.test.ts`in besinci arıza kipi notu aynen gecerlidir: sabiti
 * kullanan bir fixture, sabiti bozan mutantla BIRLIKTE mutasyona ugrar ve
 * test kendisinin sahtesi olur.
 */
const OBSERVED_GRADUATION_TARGET_UNSET = '0xfe30fa5b'
const OBSERVED_NOT_COMPLETE = '0x0701727f'

describe('classifyRevert -- canli olculmus veriler', () => {
  it('ABI turetmesi ile canli olcum AYNI selector\'u verir', () => {
    expect(MEASURED_SELECTORS.GraduationTargetUnset).toBe(OBSERVED_GRADUATION_TARGET_UNSET)
    expect(MEASURED_SELECTORS.NotComplete).toBe(OBSERVED_NOT_COMPLETE)
    expect(() => {
      assertSelectorsAgree()
    }).not.toThrow()
  })

  it('GraduationTargetUnset HICBIR YOLDAN sayfaya donusemez', () => {
    const result = classifyRevert(OBSERVED_GRADUATION_TARGET_UNSET)
    expect(result.code).toBe('target-unset')
    expect(result.errorName).toBe('GraduationTargetUnset')
    expect(result.level).toBe('ok')
    // BU SATIR GOREV TANIMININ ACIK SARTI. `level` tek basina yetmez: `pageable`
    // yurutucunun "ust uste N basarisizlik -> yukselt" yolunu da kapatir.
    expect(result.pageable).toBe(false)
    expect(result.disposition).toBe('retry')
  })

  it('AlreadyGraduated bir ARIZA DEGILDIR -- terminal, sessiz', () => {
    const result = classifyRevert('0xe6a0d45f')
    expect(result.code).toBe('already-graduated')
    expect(result.level).toBe('ok')
    expect(result.pageable).toBe(false)
    expect(result.disposition).toBe('done')
  })

  it('NotComplete yeniden denenir ve sayfa cikarabilir', () => {
    const result = classifyRevert(OBSERVED_NOT_COMPLETE)
    expect(result.code).toBe('not-complete')
    expect(result.disposition).toBe('retry')
    expect(result.pageable).toBe(true)
  })

  it('bloklanmis odeme hedefi KARANTINAYA girer ve sayfa cikarir', () => {
    const result = classifyRevert('0x1ee5f101')
    expect(result.errorName).toBe('GraduationPayoutFailed')
    expect(result.code).toBe('payout-rejected')
    expect(result.level).toBe('page')
    expect(result.disposition).toBe('quarantine')
  })

  it('kanonik olmayan curve KARANTINAYA girer', () => {
    const result = classifyRevert('0x2da03691')
    expect(result.errorName).toBe('CurveNotFromFactory')
    expect(result.disposition).toBe('quarantine')
    expect(result.level).toBe('page')
  })

  it('NotGraduationTarget sayfadir ama karantina DEGILDIR', () => {
    // Karantina yanlis olurdu: hedefi geri isaretlemek ONU cozer ve curve
    // hicbir sey degismeden yeniden denenebilir olur.
    const result = classifyRevert('0x7277e657')
    expect(result.code).toBe('not-the-target')
    expect(result.level).toBe('page')
    expect(result.disposition).toBe('retry')
  })

  it('tanimadigi selector SAYFADIR -- fail-closed', () => {
    const result = classifyRevert('0xdeadbeef')
    expect(result.code).toBe('unknown-revert')
    expect(result.errorName).toBeNull()
    expect(result.selector).toBe('0xdeadbeef')
    expect(result.level).toBe('page')
    expect(result.pageable).toBe(true)
  })

  it('VERISIZ revert ile ARAC HATASI ayri seylerdir', () => {
    for (const empty of [undefined, null, '0x', '']) {
      const result = classifyRevert(empty)
      expect(result.code).toBe('unknown-revert')
      expect(result.selector).toBeNull()
      expect(result.level).toBe('page')
    }
  })

  it('fork artefakti `FailedInnerCall()` de tanimadigi selector olarak duser', () => {
    // OLCULDU, anvil --fork-url Arc: gercek `ArcpadLocker` USDC'nin
    // `0x1800...` precompile'ina ulasir, revm oradaki tek bayti (`0x01`) ADD
    // olarak calistirir ve OZ `Address` sarmalayicisi `0x1425ea42` uretir.
    // Yani fork'ta gercek locker CALISMAZ ve bu, kesif/yayin yolunun degil
    // ORTAMIN bir ozelligidir.
    const result = classifyRevert('0x1425ea42')
    expect(result.code).toBe('unknown-revert')
    expect(result.level).toBe('page')
  })

  it('Error(string) ve Panic(uint256) ADIYLA raporlanir', () => {
    expect(classifyRevert('0x08c379a0…').errorName).toBe('Error(string)')
    expect(classifyRevert('0x4e487b71…').errorName).toBe('Panic(uint256)')
  })

  it('selector BUYUK HARFLE gelse de taninir', () => {
    expect(classifyRevert('0xFE30FA5B').code).toBe('target-unset')
  })
})

describe('chainErrorClassification', () => {
  it('tek bir zincir arizasi sayfa DEGILDIR, ust uste sureni sayfadir', () => {
    expect(chainErrorClassification('boom', 1).level).toBe('ok')
    expect(chainErrorClassification('boom', CHAIN_ERRORS_BEFORE_PAGE).level).toBe('page')
  })
})
