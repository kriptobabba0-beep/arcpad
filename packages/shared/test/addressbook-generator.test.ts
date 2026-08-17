import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'

import { resolveSmokePair } from '../src/addresses'

/**
 * NEDEN BURADA VE NEDEN `scripts/` ALTINDA DEGIL.
 *
 * `resolveSmokePair` ADRES DEFTERI SEMANTIGIDIR -- "bu defter hangi smoke
 * ciftini alir" sorusu, `loadAddressBook`in cevapladigi sorularin ayni
 * ailesindendir. Once `scripts/addressbook.ts` icinde yazildi ve bu suite onu
 * oradan import etti; `tsc` HAKLI OLARAK reddetti (`rootDir` ihlali). Ret
 * yerlestirmenin yanlis oldugunu soyluyordu, testin degil.
 *
 * O ret bir sey daha ortaya cikardi: `scripts/` HIC typecheck EDILMIYOR. Kok
 * `typecheck` betigi `pnpm -r typecheck`tir ve yalnizca paketlere iner, yani
 * `scripts/` altindaki hicbir dosya bir tsc programina girmiyordu. Bu test
 * dosyasi `addressbook.ts`i ilk kez bir programa soktu ve orada YATAN bir tip
 * hatasi ortaya cikti (`read<T>(functionName: string)`). Kok bir typecheck'i
 * MAINNET-READINESS'ta acik kalem olarak kayitlidir.
 */

const FACTORY_A = getAddress('0x5ca156f1809ab784655410d0f4b0704d2b306b47')
const FACTORY_B = getAddress('0x0d75a4ffb8cd6db4237557e9519591b94d6ab439')
const TOKEN = getAddress('0x085c926e24ed64bb045e67d26d9e76e5730c21b3')
const CURVE = getAddress('0xddb9e739a948c968eb4c7e1449b94c598b1cf27b')
const OLD_TOKEN = getAddress('0x1bd93613a7bc470a739d9615cdc65e535d958fab')
const OLD_CURVE = getAddress('0x7938be340a14a12f94a83aea246d9d2566324c9c')

const bookWith = (factory: string, token: string | null, curve: string | null) => ({
  launchFactory: factory,
  smokeToken: token,
  smokeCurve: curve,
})

describe('resolveSmokePair', () => {
  it('takes both addresses from the command line when both are given', () => {
    const r = resolveSmokePair(TOKEN, CURVE, null, FACTORY_A)
    expect(r.smokeToken).toBe(TOKEN)
    expect(r.smokeCurve).toBe(CURVE)
    expect(r.source).toContain('command line')
  })

  /**
   * OLCULEN HATANIN REGRESYONU (2026-08-05, tekrar 2026-08-08).
   *
   * `--smoke-token` IKI is birden yapar: zincirden `TOTAL_SUPPLY()` okunacak
   * token'i secer VE defterin alanini doldurur. `--smoke-curve` yalnizca
   * ikincisini yapar. Zincir okumasi icin `--smoke-token` gecmek ZORUNLU
   * oldugundan, "yalnizca token" en kolay ve en olasi kosu bicimiydi -- ve
   * `smokeToken` dolu / `smokeCurve` bos bir defter yazardi. Fork kapisi
   * ("the pair must move together") bunu reddeder: jenerator, kendi kapisinin
   * kabul etmedigi bir dosya uretiyordu. Artik BURADA durur.
   */
  it('refuses a half pair instead of writing one, and names the missing flag', () => {
    expect(() => resolveSmokePair(TOKEN, null, null, FACTORY_A)).toThrow(/--smoke-curve/)
    expect(() => resolveSmokePair(null, CURVE, null, FACTORY_A)).toThrow(/--smoke-token/)
  })

  it('says the pair moves together, so the message explains the rule and not just the symptom', () => {
    expect(() => resolveSmokePair(TOKEN, null, null, FACTORY_A)).toThrow(/MOVES TOGETHER/)
  })

  it('carries the pair forward when the factory is unchanged', () => {
    const r = resolveSmokePair(null, null, bookWith(FACTORY_A, TOKEN, CURVE), FACTORY_A)
    expect(r.smokeToken).toBe(TOKEN)
    expect(r.smokeCurve).toBe(CURVE)
    expect(r.source).toContain('carried')
  })

  /**
   * TASK 7'NIN GERCEK DURUMU. Faz 2 yeni bir fabrika yayinladi; onceki
   * defterin smoke cifti SUPERSEDE EDILMIS fabrikanin urunuydu ve yeni
   * fabrikada `isCanonical` DEGILDIR. `null` burada bir kayip degil DOGRU
   * degerdir -- ve carry-forward'i "her zaman tasi" diye yazmak, kapiyi
   * kiran bir defter uretirdi.
   */
  it('DROPS the pair when the factory changed, because it belongs to a superseded factory', () => {
    const r = resolveSmokePair(null, null, bookWith(FACTORY_B, OLD_TOKEN, OLD_CURVE), FACTORY_A)
    expect(r.smokeToken).toBeNull()
    expect(r.smokeCurve).toBeNull()
    expect(r.source).toContain('superseded')
  })

  it('is null with no previous book, and says so rather than claiming a drop', () => {
    const r = resolveSmokePair(null, null, null, FACTORY_A)
    expect(r.smokeToken).toBeNull()
    expect(r.source).toContain('no previous book')
  })

  it('is null when the previous book has the same factory but a null pair', () => {
    const r = resolveSmokePair(null, null, bookWith(FACTORY_A, null, null), FACTORY_A)
    expect(r.smokeToken).toBeNull()
    expect(r.smokeCurve).toBeNull()
    expect(r.source).toContain('no smoke pair')
  })

  it('normalises carried addresses to checksummed form rather than trusting the file', () => {
    const r = resolveSmokePair(
      null,
      null,
      bookWith(FACTORY_A.toLowerCase(), TOKEN.toLowerCase(), CURVE.toLowerCase()),
      FACTORY_A,
    )
    expect(r.smokeToken).toBe(TOKEN)
    expect(r.smokeCurve).toBe(CURVE)
  })

  /**
   * Fabrika karsilastirmasi BUYUK-KUCUK HARFE duyarli olsaydi, checksum'li bir
   * defter ile kucuk harfli bir makbuz ayni fabrikayi FARKLI gorur ve cift
   * her yeniden uretimde sessizce dusurulurdu -- yani duzeltmenin kendisi
   * duzelttigi hatanin taze bir ornegini tasirdi.
   */
  it('compares factories by value, not by spelling', () => {
    const r = resolveSmokePair(
      null,
      null,
      bookWith(FACTORY_A.toLowerCase(), TOKEN, CURVE),
      FACTORY_A,
    )
    expect(r.source).toContain('carried')
  })
})
