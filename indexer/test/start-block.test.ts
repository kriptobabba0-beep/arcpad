import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { createPacer, type RpcClient } from '../src/logs'
import {
  assertStartBlockCoversEscrow,
  HistoricalStateUnavailable,
  isTransient,
  StartBlockAfterEscrow,
} from '../src/run'

/**
 * ACILIS KAPISI: `startBlock` ESCROW'UN YARATILISINI KAPSIYOR MU.
 *
 * NEDEN VAR -- OLCULMUS BIR OLGU, BIR TAHMIN DEGIL. Faz 2 factory'yi yeniden
 * dagitip escrow'u DEVRALDI. 2026-08-09'da canli Arc testnet'in TAM gecmisi
 * tarandi (121 + 14 `eth_getLogs`, escrow adresine, iki topic'e):
 *
 *   [54661437, 55870260]  factory HENUZ YOKKEN  -> 8 Deposited, 152069146725900635
 *   [55870261, 56010150]  factory VARKEN        -> 8 Deposited, 169145637607642894
 *   toplam 321214784333543529 = zincirin `totalOwed()`i = escrow'un bakiyesi
 *
 * VE IKI YARININ ALICILARI AYNI:
 *
 *   hazine  0xebbecfda...  115572551511684482 + 128550684581808599 = 244123236093493081
 *   creator 0xe92c64c4...   36496595214216153 +  40594953025834295 =  77091548240050448
 *
 * Ikisi de zincirin `owed(...)` cevabiyla WEI WEI ayni. Yani "1,2M bos blogu
 * atlayalim" optimizasyonu defteri 152069146725900635 wei eksik birakir ve
 * eksik AYNI IKI SLOTA dagilir; ilk `claim()` slotun tamamini oder ve defter
 * `CHECK (claimable_wei >= 0)` ile KALICI olarak kilitlenir
 * (`shared-escrow.test.ts` bunu calistirarak olcuyor).
 *
 * Bu dosya kapinin KENDISINI olcuyor: gecmesi gereken yerde geciyor mu,
 * gecmemesi gereken yerde HANGI SEBEPLE duruyor.
 */

const ESCROW = '0xeed4431ead3e27f16d97f677a9c4c1a963df8dc6' as Address
const USDC = '0x3600000000000000000000000000000000000000'

/** OLCULEN kod boyutlari (canli Arc testnet, 2026-08-09). */
const USDC_BYTES = 1798
const ESCROW_BYTES = 681
const ESCROW_BLOCK = 54_661_437n

interface Probe {
  address: string
  block: bigint
}

/**
 * `eth_getCode`u OLCULEN zincir gecmisiyle yanitlar.
 *
 * Sahte, kapinin isini YAPMAZ -- yalnizca iki olguyu tasir: escrow
 * 54661437'de var oldu, USDC onderlemesi HER yukseklikte var. Ikisi de
 * yukaridaki kosumdan.
 */
function node(opts: { usdcEverywhere?: boolean } = {}): RpcClient & { probes: Probe[] } {
  const probes: Probe[] = []
  const usdcEverywhere = opts.usdcEverywhere ?? true
  return {
    probes,
    async request({ method, params }) {
      if (method !== 'eth_getCode') throw new Error(`beklenmeyen metod: ${method}`)
      const [address, tag] = params as [string, Hex]
      const block = BigInt(tag)
      probes.push({ address: address.toLowerCase(), block })
      if (address.toLowerCase() === USDC) {
        return usdcEverywhere ? `0x${'ab'.repeat(USDC_BYTES)}` : '0x'
      }
      if (address.toLowerCase() === ESCROW && block >= ESCROW_BLOCK) {
        return `0x${'cd'.repeat(ESCROW_BYTES)}`
      }
      return '0x'
    },
  }
}

const pacer = (): ReturnType<typeof createPacer> => createPacer({ minIntervalMs: 0 })

describe('assertStartBlockCoversEscrow', () => {
  it('defterin startBlock u GECER -- escrow o blokta HENUZ yoktu', async () => {
    const client = node()
    await expect(
      assertStartBlockCoversEscrow(client, ESCROW, ESCROW_BLOCK, pacer()),
    ).resolves.toBeUndefined()
    // Ve GERCEKTEN sordu: iki sonda, ikisi de `startBlock - 1`de.
    expect(client.probes).toEqual([
      { address: USDC, block: ESCROW_BLOCK - 1n },
      { address: ESCROW, block: ESCROW_BLOCK - 1n },
    ])
  })

  /**
   * ASIL VAKA: TRAP 3'UN DAVET ETTIGI "OPTIMIZASYON".
   *
   * `launchFactoryBlock` (55870261) escrow'un blogundan 1.208.824 blok
   * SONRADIR; oradan baslamak sekiz gercek `Deposited`i atlar.
   */
  it('factory nin bloguna atlamak REDDEDILIR', async () => {
    const client = node()
    const error = await assertStartBlockCoversEscrow(client, ESCROW, 55_870_261n, pacer()).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(StartBlockAfterEscrow)
    const typed = error as StartBlockAfterEscrow
    expect(typed.probeBlock).toBe(55_870_260n)
    expect(typed.codeBytes).toBe(ESCROW_BYTES)
    // Mesaj MEKANIZMAYI soyluyor, yalnizca "yanlis" demiyor: bir sonraki
    // operator neden geri alamayacagini burada okur.
    expect(typed.message).toMatch(/claimable_wei/)
    expect(typed.message).toMatch(/min\(feeEscrowBlock, launchFactoryBlock\)/)
  })

  it('escrow un blogundan BIR SONRASI bile REDDEDILIR (sinir)', async () => {
    await expect(
      assertStartBlockCoversEscrow(node(), ESCROW, ESCROW_BLOCK + 1n, pacer()),
    ).rejects.toBeInstanceOf(StartBlockAfterEscrow)
  })

  it('escrow un blogundan ONCESI GECER (erken baslamak yalnizca bos tarar)', async () => {
    await expect(
      assertStartBlockCoversEscrow(node(), ESCROW, ESCROW_BLOCK - 1_000n, pacer()),
    ).resolves.toBeUndefined()
  })

  /**
   * POZITIF KONTROL -- BU DUZELTMENIN ICINDEKI KUSURU KAPATAN SEY.
   *
   * State tutmayan bir dugum HER adres icin `0x` doner, yani escrow'un
   * "yoklugu" bir olgu degil bir yan etkidir ve kapi SESSIZCE gecerdi. Bu
   * test o sessiz gecisi bir HATAYA cevirdigimizi olcuyor -- ve ayirt edici
   * olmasi icin `startBlock` KAPIYI NORMALDE GECECEK bir deger:
   * yalnizca kontrol dustugu icin patliyor.
   */
  it('dugum o yukseklikte state vermiyorsa kapi GECMEZ, HATA verir', async () => {
    const client = node({ usdcEverywhere: false })
    const error = await assertStartBlockCoversEscrow(client, ESCROW, ESCROW_BLOCK, pacer()).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(HistoricalStateUnavailable)
    // NEGATIF KONTROL: escrow'a HIC sorulmadi -- kontrol dusunce okuma
    // anlamsizdir ve yapilmaz.
    expect(client.probes.map((p) => p.address)).toEqual([USDC])
  })

  /**
   * `startBlock <= 1` iken SORU YOK ve HICBIR CAGRI YAPILMAZ. Blok 0'in
   * oncesi yoktur; blok 0 islem tasimaz, yani makbuz ve log da tasimaz.
   */
  it('startBlock 0 ve 1 icin hicbir RPC cagrisi yapilmaz', async () => {
    for (const start of [0n, 1n]) {
      const client = node()
      await expect(
        assertStartBlockCoversEscrow(client, ESCROW, start, pacer()),
      ).resolves.toBeUndefined()
      expect(client.probes).toEqual([])
    }
  })

  /**
   * IKI OLGU DA HALT SINIFINDA -- VE BU IDDIA AYIRT EDICI OLMAK ZORUNDA.
   *
   * BU TESTIN ILK HALI VAKUMDU, ve onu bir MUTASYON gosterdi: adi
   * `PERMANENT`ten cikardim, `isTransient` YINE `false` dondu ve test
   * GECMEYE DEVAM ETTI. Sebep `isTransient`in son satiri: "bilinmeyen hata
   * KALICIDIR". Yani olculen sey siniflandirma kararim degil, varsayilanin
   * kendisiydi -- bu dosyanin duzeltmeye calistigi ariza sinifinin
   * (`run.ts`in kendi notu: "kimsenin yazmadigi bir sebeple gecen test")
   * duzeltmenin ICINDEKI taze ornegi.
   *
   * BUGUN GOVDE BIR HIZ SINIRIDIR (`code: -32011`), yani ad kontrolu
   * olmasaydi `isRateLimit` devreye girer ve sonuc GECICI olurdu. Gecen tek
   * sey ADIN KUMEDE OLMASI. Ucuncu satir kanitin kendisi: adi dusurulen AYNI
   * nesne gecici cikiyor. (`rpc-errors.test.ts` ayni kontrolu KAYNAKTAN
   * turetilen kume uzerinde gercek bir viem hatasiyla da yapiyor.)
   */
  it('iki hata da KALICIDIR -- hiz siniri govdesine RAGMEN', () => {
    for (const error of [
      new StartBlockAfterEscrow(ESCROW, 55_870_261n, 55_870_260n, 681),
      new HistoricalStateUnavailable(1n, USDC as Address),
    ]) {
      const rateLimited = Object.assign(error, { code: -32011 })
      expect(isTransient(rateLimited), error.name).toBe(false)
      // NEGATIF KONTROL: adi dusur, AYNI nesne GECICI olsun.
      const anonymous = Object.assign(
        Object.create(Object.getPrototypeOf(rateLimited) as object) as object,
        rateLimited,
        { name: 'Bilinmeyen' },
      )
      expect(isTransient(anonymous), error.name).toBe(true)
    }
  })
})
