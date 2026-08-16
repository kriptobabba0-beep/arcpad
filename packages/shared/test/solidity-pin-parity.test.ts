import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ARCPAD_HOOK_SALT, LOCKER_SALT, POOL_MANAGER_SALT, ROUTER_SALT } from '../src/addresses'
import { REPO_ROOT } from '../src/profiles'

/**
 * TYPESCRIPT SABITLERI SOLIDITY SABITLERIYLE AYNI OLMALI.
 *
 * NICIN BU DOSYA VAR -- OLCULMUS BIR SESSIZ AYRISMA.
 *
 * `addresses.ts` `ARCPAD_HOOK_SALT`i **13** olarak tasiyordu ve yaninda su
 * yaziyordu: "ayni sayi IKI ayri derleme biriminde; ayrisirlarsa biri kirmizi
 * olur." O cumle bir DILEKTI, bir kapi degil: hook IKI KEZ yeniden madenlendi
 * (denetim duzeltmesi -> `0x1273`, buyback nesli -> `0x33f6`) ve TypeScript
 * tarafi ikisinde de 13'te kaldi. Hicbir test kirmizi olmadi.
 *
 * BEDELI OLCULDU: `scripts/addressbook.ts` hook adresini bu tuzdan turetir.
 * Bayat tuzla `0xd95198Cd...e0cC` uretti -- ne V1 ne V2, ILK madencilik
 * turundan kalma bir adres. Defter jeneratoru o adresi canli router'in
 * `hook()` degeriyle karsilastirdigi icin DUSTU; yani ariza ancak BASKA bir
 * kapinin yan urunu olarak gorunur oldu. O kapi olmasaydi defter yanlis bir
 * hook adresiyle YAZILIRDI.
 *
 * NEDEN ONCEKI TEST YETMEDI: `barrel-salts.test.ts` her tuzun barrel'dan
 * DISARI VERILDIGINI olcer -- DEGERINI degil. `undefined` olmayan ama YANLIS
 * bir tuz o testten sorunsuz gecer.
 *
 * BU DOSYA DEGERI OLCER, VE KAYNAGI SOLIDITY'DIR: `.sol` dosyalari okunur ve
 * literaller ayristirilir. Elle yazilmis ikinci bir liste, ayni kisi
 * tarafindan ayni anda guncellenmek zorunda olurdu -- ki bu hic kapi degildir.
 */

function solSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

/** `bytes32 internal constant <AD> = bytes32(uint256(0x....));` */
function bytes32UintLiteral(source: string, name: string): bigint {
  const re = new RegExp(
    `${name}\\s*=\\s*bytes32\\(\\s*uint256\\(\\s*(0x[0-9a-fA-F]+|\\d+)\\s*\\)\\s*\\)`,
  )
  const m = re.exec(source)
  if (m?.[1] === undefined) throw new Error(`${name}: Solidity kaynaginda literal bulunamadi`)
  return BigInt(m[1])
}

/** `keccak256("...")` ile turetilen tuzlarin ISIM DIZESI. */
function keccakSaltName(source: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*keccak256\\("([^"]+)"\\)`)
  const m = re.exec(source)
  if (m?.[1] === undefined) throw new Error(`${name}: keccak256("...") bulunamadi`)
  return m[1]
}

const POOL_DEPLOY_LIB = 'contracts/script/PoolDeployLib.sol'
const ROUTER_DEPLOY_LIB = 'contracts/script/RouterDeployLib.sol'

describe('TypeScript tuzlari Solidity ile ayni', () => {
  /**
   * HOOK TUZU -- AYRISMANIN GERCEKTEN YASANDIGI SATIR.
   *
   * Tek MADENLENMIS tuz budur, yani tek "secilmemis-degil" olan. Digerleri bir
   * isim dizesinin keccak'idir ve degisebilmeleri icin ismin degismesi gerekir;
   * bu ise bytecode her kaydiginda YENIDEN ARANIR.
   */
  it('ARCPAD_HOOK_SALT, PoolDeployLib.ARC_HOOK_SALT ile ayni', () => {
    const sol = bytes32UintLiteral(solSource(POOL_DEPLOY_LIB), 'ARC_HOOK_SALT')
    expect(BigInt(ARCPAD_HOOK_SALT)).toBe(sol)
  })

  /**
   * ...VE ESKI NESLIN TUZUYLA AYNI OLMAMALI.
   *
   * ANTI-VAKUM: yukaridaki iddia, ikisi de bayatlarsa yine gecerdi. Bu satir
   * "guncel" ile "ayni sekilde eski" arasini ayirir -- `LEGACY_V1_HOOK_SALT`
   * kasten kayit icin duruyor ve hicbir zaman AKTIF tuz olmamali.
   */
  it('hook tuzu LEGACY_V1 tuzuna esit DEGIL', () => {
    const src = solSource(POOL_DEPLOY_LIB)
    const legacy = bytes32UintLiteral(src, 'LEGACY_V1_HOOK_SALT')
    expect(BigInt(ARCPAD_HOOK_SALT)).not.toBe(legacy)
    // ...ve ilk madencilik turunun tuzu (13) da geri gelmemeli.
    expect(BigInt(ARCPAD_HOOK_SALT)).not.toBe(13n)
  })

  /**
   * TURETILEN TUZLAR: isim dizesi iki tarafta da ayni olmali.
   *
   * Degerleri karsilastirmak yerine ISMI karsilastirmak KASITLIDIR: iki taraf
   * da `keccak256(isim)` hesaplar, yani ayni isim zorunlu olarak ayni degeri
   * verir. Isim ayrisirsa deger de ayrisir; degeri karsilastirmak ayni seyi
   * daha dolayli soylerdi.
   */
  it.each([
    ['POOL_MANAGER_SALT', POOL_MANAGER_SALT, POOL_DEPLOY_LIB, 'POOL_MANAGER_SALT'],
    ['LOCKER_SALT', LOCKER_SALT, POOL_DEPLOY_LIB, 'LOCKER_SALT'],
    ['ROUTER_SALT', ROUTER_SALT, ROUTER_DEPLOY_LIB, 'ROUTER_SALT'],
  ])('%s Solidity ile ayni isimden turetiliyor', async (_label, tsValue, file, solName) => {
    const name = keccakSaltName(solSource(file), solName)
    const { keccak256, toBytes } = await import('viem')
    expect(tsValue).toBe(keccak256(toBytes(name)))
  })

  /**
   * AYRISTIRICININ KENDISI OLCULUR.
   *
   * Bir regex'in hicbir sey bulmamasi, bu dosyadaki her iddiayi SESSIZCE
   * vakumlastirirdi -- `expect(x).toBe(x)` haline gelirdi. Bu yuzden
   * ayristiricilar bilinen bir girdide sinanir ve bulamadiklarinda FIRLATIR.
   */
  it('ayristirici gercekten ayristiriyor, bulamayinca duser', () => {
    const src = solSource(POOL_DEPLOY_LIB)
    expect(bytes32UintLiteral(src, 'ARC_HOOK_SALT')).toBeGreaterThan(0n)
    expect(keccakSaltName(src, 'POOL_MANAGER_SALT')).toBe('arcpad.PoolManager.v1')
    expect(() => bytes32UintLiteral(src, 'BOYLE_BIR_SABIT_YOK')).toThrow()
    expect(() => keccakSaltName(src, 'BOYLE_BIR_SABIT_YOK')).toThrow()
  })
})
