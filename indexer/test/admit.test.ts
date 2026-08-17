import { beforeEach, describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { concatHex, encodeAbiParameters, hexToString, keccak256 } from 'viem'
import { withTransaction } from '@arcpad/db'
import {
  admit,
  deriveTokenAddress,
  NonCanonicalLaunch,
  recordRejection,
  rejectionOf,
} from '../src/admit'
import {
  LAUNCH_TOKEN_CREATION_CODE,
  LAUNCH_TOKEN_CREATION_CODE_HASH,
  LAUNCH_TOKEN_CREATION_CODE_SIZE,
} from '../src/launch-token.generated'
import type { LaunchedEvent } from '../src/logs'
import { createPacer, decodeAll } from '../src/logs'
import { FakeNode, LIVE, loadSmoke, rawLogs } from './fixtures'
import { LIVE_DEPLOYMENT, pool, resetSchema, seedDeployment } from './db'

const BLOCK = 54_661_437n

async function launchedFrom(source: 'live' | 'launch' | 'forged'): Promise<LaunchedEvent> {
  const logs =
    source === 'live'
      ? loadSmoke().receipts.find((r) => r.scenario === 'launch')!.logs
      : rawLogs(source, { block: BLOCK })
  const first = BigInt(logs[0]!.blockNumber)
  const events = await decodeAll(new FakeNode([]), logs, first, first, createPacer())
  const launched = events.find((e) => e.kind === 'launched')
  if (launched === undefined) throw new Error(`${source} icinde Launched yok`)
  return launched
}

async function count(table: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)
  return Number(rows[0]!.n)
}

function inputOf(event: LaunchedEvent, factory: Address): Parameters<typeof deriveTokenAddress>[0] {
  return {
    factory,
    salt: event.salt,
    nameHex: event.nameHex,
    symbolHex: event.symbolHex,
    uriHex: event.uriHex,
    creator: event.creator,
    curve: event.curve,
  }
}

// ---------------------------------------------------------------------------
// Turetme -- gercek zincire karsi
// ---------------------------------------------------------------------------

describe('deriveTokenAddress', () => {
  it('CANLI Arc launch inin token adresini yeniden uretir', async () => {
    const event = await launchedFrom('live')
    expect(event.factory).toBe(LIVE.factory)
    expect(deriveTokenAddress(inputOf(event, LIVE.factory))).toBe(LIVE.token)
  })

  // Bu iddia AYNI ZAMANDA `launch-token.generated.ts`'in kapisidir: commit'li
  // creationCode zincirdeki `LaunchToken` ile ayni olmasaydi bu adres tutmazdi.
  // `contracts/out/` .gitignore'da oldugu icin CI'da artifact'a karsi bir
  // parity testi kosamaz -- kapinin yerini ZINCIR aliyor.
  it('commit li creationCode olculmus boyut ve hash i tasir', () => {
    expect(LAUNCH_TOKEN_CREATION_CODE_SIZE).toBe(3598)
    expect((LAUNCH_TOKEN_CREATION_CODE.length - 2) / 2).toBe(3598)
    expect(LAUNCH_TOKEN_CREATION_CODE_HASH).toBe(
      '0x3c7ca45505c038e707c0384e4c5861f15aace17f85486470a42737142f966fe4',
    )
    expect(keccak256(LAUNCH_TOKEN_CREATION_CODE)).toBe(LAUNCH_TOKEN_CREATION_CODE_HASH)
  })

  it('YEREL fixture in token adresini de yeniden uretir', async () => {
    const event = await launchedFrom('launch')
    expect(deriveTokenAddress(inputOf(event, event.factory))).toBe(event.token)
  })

  // Elle yazilmis ABI kodlamasi ile viem'in kodlamasi ayni olmali (gecerli
  // UTF-8 icin). Ayrisirlarsa hangisinin dogru oldugunu ZINCIR soyler ve
  // ustteki test onu zaten tutuyor; bu test farkin YERINI gosterir.
  it('elle yazilan abi.encode viem in kodlamasiyla ortusur', async () => {
    const event = await launchedFrom('live')
    const args = encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'string' },
        { type: 'string' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
      ],
      [
        hexToString(event.nameHex),
        hexToString(event.symbolHex),
        hexToString(event.uriHex),
        event.creator,
        event.curve,
        event.salt,
      ],
    )
    const initCodeHash = keccak256(concatHex([LAUNCH_TOKEN_CREATION_CODE, args]))
    const viemDerived =
      `0x${keccak256(concatHex(['0xff', event.factory, event.salt, initCodeHash])).slice(-40)}`.toLowerCase()
    expect(deriveTokenAddress(inputOf(event, event.factory))).toBe(viemDerived)
  })

  // ALTI ALANIN ALTISI DA TASIYICIDIR. Alan atlamanin en olasi hali `uri`yi
  // turetmeden dusurmektir; o zaman bir sahteci URI'yi serbestce degistirip
  // kanonik kalabilirdi (`LaunchFactory.sol:542`).
  it('alti alanin her biri adresi kaydirir', async () => {
    const event = await launchedFrom('live')
    const base = deriveTokenAddress(inputOf(event, event.factory))
    const flip = (hex: Hex): Hex => `0x${hex.slice(2, 4) === 'aa' ? 'bb' : 'aa'}${hex.slice(4)}`
    const mutations: Record<string, Parameters<typeof deriveTokenAddress>[0]> = {
      name: { ...inputOf(event, event.factory), nameHex: flip(event.nameHex) },
      symbol: { ...inputOf(event, event.factory), symbolHex: flip(event.symbolHex) },
      uri: { ...inputOf(event, event.factory), uriHex: flip(event.uriHex) },
      creator: { ...inputOf(event, event.factory), creator: flip(event.creator) as Address },
      curve: { ...inputOf(event, event.factory), curve: flip(event.curve) as Address },
      salt: { ...inputOf(event, event.factory), salt: flip(event.salt) },
      factory: inputOf(event, flip(event.factory) as Address),
    }
    for (const [field, input] of Object.entries(mutations)) {
      expect(deriveTokenAddress(input), `${field} tasiyici degil`).not.toBe(base)
    }
  })

  // Uzunluk degisince yastiklama da degisir; ayni uzunlukta bir bayt
  // degisikligi (ustteki) TEK basina bu yolu kapsamaz.
  it('bir bayt UZATMAK da adresi kaydirir', async () => {
    const event = await launchedFrom('live')
    const base = deriveTokenAddress(inputOf(event, event.factory))
    const longer = { ...inputOf(event, event.factory), nameHex: `${event.nameHex}41` as Hex }
    expect(deriveTokenAddress(longer)).not.toBe(base)
  })

  // BAYAT creationCode BUTUN launch'lari reddeder. Task 1'in bytecode parity
  // kapisinin nicin var oldugu budur -- ve bu, olculebilir bir OPERASYONEL
  // tuzaktir, teorik bir uyari degil.
  it('creationCode un tek bir bayti degisirse adres tutmaz', async () => {
    const event = await launchedFrom('live')
    const stale: Hex = `0x${LAUNCH_TOKEN_CREATION_CODE.slice(2, -2)}00`
    expect(stale).not.toBe(LAUNCH_TOKEN_CREATION_CODE)
    expect(deriveTokenAddress({ ...inputOf(event, event.factory), creationCode: stale })).not.toBe(
      LIVE.token,
    )
  })

  // COZULMUS DIZGEDEN TURETME YANLIS CEVAP VERIR. Brief'in imzasi
  // (`name: string`) tam olarak bunu yapardi.
  it('dusman metinli bir launch ta ham bayt ile dizge AYRISIR', () => {
    // Gecersiz UTF-8: 0xff tek basina bir kod noktasi degildir. `hexToString`
    // onu U+FFFD yapar ve geri kodlamak 3 bayt verir.
    const hostileHex: Hex = '0x41ff42'
    const decoded = hexToString(hostileHex)
    const reencoded = `0x${Buffer.from(decoded, 'utf8').toString('hex')}` as Hex
    expect(reencoded).not.toBe(hostileHex)

    const base = {
      factory: LIVE.factory,
      salt: `0x${'11'.repeat(32)}` as Hex,
      symbolHex: '0x414243' as Hex,
      uriHex: '0x69706673' as Hex,
      creator: LIVE.factory,
      curve: LIVE.curve,
    }
    expect(deriveTokenAddress({ ...base, nameHex: hostileHex })).not.toBe(
      deriveTokenAddress({ ...base, nameHex: reencoded }),
    )
  })
})

// ---------------------------------------------------------------------------
// admit -- veritabani
// ---------------------------------------------------------------------------

describe('admit', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
  })

  it('CANLI launch kabul edilir ve dort tabloyu birden kurar', async () => {
    const event = await launchedFrom('live')
    expect(await admit(pool, LIVE_DEPLOYMENT, event)).toBe(1)

    const { rows } = await pool.query(
      `SELECT l.token, l.curve, l.launch_creator, l.name, l.symbol, l.uri,
              l.name_hex, l.salt, c.virtual_token_reserves_tok, c.virtual_quote_reserves_wei,
              c.real_token_reserves_tok, c.real_quote_reserves_wei, c.complete,
              s.holder_count, h.creator AS history_creator
         FROM launches l
         JOIN curve_state c ON c.token = l.token
         JOIN token_stats s ON s.token = l.token
         JOIN creator_history h ON h.token = l.token`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      token: LIVE.token,
      curve: LIVE.curve,
      name: 'Arcpad Smoke',
      symbol: 'SMOKE',
      uri: 'ipfs://arcpad-smoke-v1',
      // ACILIS DEGERLERI `deployment`tan gelir: rT = saleSupply, rQ = 0.
      virtual_token_reserves_tok: '1073000000000000000000000000',
      virtual_quote_reserves_wei: '4292000000000000000',
      real_token_reserves_tok: '793100000000000000000000000',
      real_quote_reserves_wei: '0',
      complete: false,
      holder_count: 0,
    })
    // Acilis rezervleri, canli `Trade` loglarinin ozdesligini SAGLAR:
    // vT - rT = 279_900_000e18.
    expect(
      BigInt(rows[0]!['virtual_token_reserves_tok'] as string) -
        BigInt(rows[0]!['real_token_reserves_tok'] as string),
    ).toBe(279_900_000n * 10n ** 18n)
  })

  it('ayni launch i iki kez kabul etmek ikinci seferde hicbir sey yazmaz', async () => {
    const event = await launchedFrom('live')
    expect(await admit(pool, LIVE_DEPLOYMENT, event)).toBe(1)
    // IKINCI cagri HICBIR SATIR yazmaz ve bunu SAYIYLA soyler.
    expect(await admit(pool, LIVE_DEPLOYMENT, event)).toBe(0)
    expect(await count('launches')).toBe(1)
    expect(await count('creator_history')).toBe(1)
    expect(await count('curve_state')).toBe(1)
    expect(await count('token_stats')).toBe(1)
  })

  // `forged.json`: rogue factory + `mint()` eklenmis `LaunchToken`. Ayni salt,
  // ayni alanlar, FARKLI creationCode.
  it('degistirilmis LaunchToken bytecode u ile uretilen token REDDEDILIR', async () => {
    const forged = await launchedFrom('forged')
    const deployment = { ...LIVE_DEPLOYMENT, factory: forged.factory }
    await expect(admit(pool, deployment, forged)).rejects.toThrow(NonCanonicalLaunch)
    expect(await count('launches')).toBe(0)
  })

  /*
   * ============================================================================
   *  `curve` ALANI TASIYICIDIR -- KULLANICININ PARASI ORAYA GIDER
   * ============================================================================
   *
   * Denetimde (ikinci tur) sorulan soru suydu: token sayfasi kullaniciya hangi
   * adrese `msg.value` gonderteceğine VERITABANINDAN karar veriyor
   * (`overview.curve`), ve o sayfa yolunda ikinci bir zincir kontrolu YOK.
   * Guvenli olmasinin TEK sebebi burasi: `curve`, token adresinin CREATE2
   * on-goruntusune GIRER, dolayisiyla sahte bir curve tasiyan bir `Launched`
   * olayi turetmede TUTMAZ ve kabul edilmez.
   *
   * Yani "veritabanindaki curve guvenilir" iddiasi bir varsayim degil, BU
   * KONTROLUN sonucudur -- ve kontrol kaldirilirsa iddia sessizce yanlis olur:
   * satir yazilir, sayfa "Canonical" cizer, para saldirganin sozlesmesine
   * gider. Bu yuzden alan ADIYLA pinleniyor.
   *
   * Ustteki `forged` testi bunu YAKALAMAZ: o bytecode'u degistirir, bu ise
   * gecerli bir launch'in TEK BIR ALANINI degistirir ve geri kalan her sey
   * dogru kalir.
   */
  it('curve ALANI degistirilmis bir Launched REDDEDILIR -- para oraya gider', async () => {
    const event = await launchedFrom('live')
    const attacker = '0x00000000000000000000000000000000deadbeef' as Address
    expect(event.curve.toLowerCase()).not.toBe(attacker)

    const tampered = { ...event, curve: attacker }
    // Turetme `curve`u iceriyorsa bu adres artik tutmaz.
    expect(deriveTokenAddress(inputOf(tampered, LIVE.factory))).not.toBe(event.token)

    await expect(admit(pool, LIVE_DEPLOYMENT, tampered)).rejects.toThrow(NonCanonicalLaunch)
    expect(await count('launches')).toBe(0)
  })

  /*
   * VE KONTROL GRUBU: degistirilmemis AYNI olay KABUL EDILIR. Onsuz ustteki
   * test "admit her seyi reddediyor" ile ayirt edilemezdi.
   */
  it('ayni olay degistirilmeden KABUL EDILIR -- red, curve yuzunden', async () => {
    const event = await launchedFrom('live')
    expect(await admit(pool, LIVE_DEPLOYMENT, event)).toBe(1)
    expect(await count('launches')).toBe(1)
  })

  it('reddin sebebi non_canonical dir ve beklenen adres kayda gecer', async () => {
    const forged = await launchedFrom('forged')
    const deployment = { ...LIVE_DEPLOYMENT, factory: forged.factory }
    const error = (await admit(pool, deployment, forged).catch(
      (e: unknown) => e,
    )) as NonCanonicalLaunch
    expect(error.reason).toBe('non_canonical')
    expect(error.token).toBe(forged.token)
    expect(error.expected).not.toBe(forged.token)

    const { rows } = await pool.query(
      'SELECT reason, expected, token, raw_addr, raw_topics_hex, raw_data_hex FROM rejected_launches',
    )
    expect(rows[0]).toMatchObject({
      reason: 'non_canonical',
      expected: error.expected,
      token: forged.token,
      raw_addr: forged.factory,
    })
    // HAM log, cozulmus alanlardan yeniden kurulamaz; oldugu gibi saklanir.
    expect(rows[0]!['raw_data_hex']).toBe(forged.rawData)
    expect((rows[0]!['raw_topics_hex'] as string).split(',')).toHaveLength(4)
  })

  // Cekme katmani zaten factory'ye gore suzuyor; `admit` yine de cagiranina
  // GUVENMEZ.
  it('yabanci bir factory nin Launched i reddedilir', async () => {
    const forged = await launchedFrom('forged')
    const error = (await admit(pool, LIVE_DEPLOYMENT, forged).catch(
      (e: unknown) => e,
    )) as NonCanonicalLaunch
    expect(error).toBeInstanceOf(NonCanonicalLaunch)
    expect(error.reason).toBe('foreign_factory')
    expect(await count('launches')).toBe(0)
  })

  /**
   * ISLEM GERI ALININCA IKISI DE BOSTUR.
   *
   * Bu bir eksiklik degil, reddin AYRI BIR BAGLANTIDA yazilmasi gerektiginin
   * olculmus kanitidir (Task 11'in isi). Ayni islemin icinde yazmak, kaydi
   * `NonCanonicalLaunch`in kendi rollback'ine kaptirir.
   */
  it('reddedilen launch ingest islemiyle birlikte GERI ALINIR', async () => {
    const forged = await launchedFrom('forged')
    const deployment = { ...LIVE_DEPLOYMENT, factory: forged.factory }
    await expect(
      withTransaction(pool, async (tx) => admit(tx, deployment, forged)),
    ).rejects.toThrow(NonCanonicalLaunch)
    expect(await count('launches')).toBe(0)
    expect(await count('rejected_launches')).toBe(0)
  })

  it('ayri bir baglantida yazilan red KALICIDIR', async () => {
    const forged = await launchedFrom('forged')
    const deployment = { ...LIVE_DEPLOYMENT, factory: forged.factory }
    const expected = deriveTokenAddress(inputOf(forged, deployment.factory))
    await expect(
      withTransaction(pool, async (tx) => admit(tx, deployment, forged)),
    ).rejects.toThrow(NonCanonicalLaunch)
    // Islem disinda, tipki Task 11'in yapacagi gibi.
    await recordRejection(pool, rejectionOf(forged, expected, 'non_canonical'))
    expect(await count('rejected_launches')).toBe(1)
    // Ve idempotenttir.
    await recordRejection(pool, rejectionOf(forged, expected, 'non_canonical'))
    expect(await count('rejected_launches')).toBe(1)
  })

  // Dusman metinli bir launch: HAM baytlardan turetilen adres kabul edilir.
  // Gosterim metni `pgSafeText`ten gecer ve U+FFFD tasir, ama `name_hex`
  // zincirdeki bayti aynen tutar -- canonicity yalnizca veritabanina bakarak
  // yeniden dogrulanabilir kalir.
  it('gecersiz UTF-8 tasiyan bir launch ham baytla kabul edilir', async () => {
    const nameHex: Hex = '0x41ff42'
    const symbolHex: Hex = '0x414243'
    const uriHex: Hex = '0x697066733a2f2f78'
    const salt: Hex = `0x${'22'.repeat(32)}`
    const curve = '0x00000000000000000000000000000000000000c1' as Address
    const creator = '0x00000000000000000000000000000000000000cc' as Address
    const token = deriveTokenAddress({
      factory: LIVE_DEPLOYMENT.factory,
      salt,
      nameHex,
      symbolHex,
      uriHex,
      creator,
      curve,
    })
    const event: LaunchedEvent = {
      kind: 'launched',
      seq: 1n,
      blockNumber: 0n,
      logIndex: 1,
      txHash: `0x${'ab'.repeat(32)}`,
      blockTime: new Date(1_800_000_000_000),
      factory: LIVE_DEPLOYMENT.factory,
      token,
      curve,
      creator,
      name: hexToString(nameHex),
      symbol: hexToString(symbolHex),
      uri: hexToString(uriHex),
      nameHex,
      symbolHex,
      uriHex,
      salt,
      rawTopics: [`0x${'00'.repeat(32)}`],
      rawData: '0x',
    }
    expect(await admit(pool, LIVE_DEPLOYMENT, event)).toBe(1)
    const { rows } = await pool.query<{ name: string; name_hex: string }>(
      'SELECT name, name_hex FROM launches',
    )
    expect(rows[0]!.name_hex).toBe(nameHex)
    // Gosterim metni ham baytlarla AYNI DEGILDIR -- ve olmamalidir.
    expect(`0x${Buffer.from(rows[0]!.name, 'utf8').toString('hex')}`).not.toBe(nameHex)
  })
})
