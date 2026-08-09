import { describe, expect, it } from 'vitest'
import { toEventSelector } from 'viem'
import {
  bondingCurveAbi,
  feeEscrowAbi,
  launchFactoryAbi,
  launchTokenAbi,
} from '@arcpad/shared/browser'
import {
  ADDRESS_FILTER_CHUNK,
  ARC_GETLOGS_MAX_RESULTS,
  EIP7708_SYSTEM_EMITTER,
  EVENT_SIGNATURES,
  FORBIDDEN_TRANSFER_EMITTERS,
  isForbiddenEmitter,
  KIND_BY_TOPIC0,
  TOPIC0,
} from '../src/arc'
import {
  ARCPAD_HOOK_SWAP_FEE_COLLECTED_EVENT,
  POOL_MANAGER_INITIALIZE_EVENT,
  POOL_MANAGER_SWAP_EVENT,
} from '../src/pool-events.generated'
import {
  allFixtureTopics,
  fixtureJsonFiles,
  fixtureNames,
  loadFixtureFile,
  loadSmoke,
} from './fixtures'

/**
 * `TOPIC0` iki YONDEN birden tutuluyor. Tek yon yeterli DEGILDIR:
 * imzayi ve literal'i birlikte yanlis yazmak ikisini de tutarli kilar --
 * GERCEK loglar tutmaz.
 */
describe('topic0 kimlikleri', () => {
  it('olculmus literallerle ortusur', () => {
    expect(TOPIC0.launched).toBe(
      '0x18335d7ceae0e8415362afcfc11b534b5bfbf6b27c59420bf3d8e783b39de1c7',
    )
    expect(TOPIC0.trade).toBe('0x733bb99acb17010119efa3b694a341a4be53fb2e7ea4800188314660780de278')
    expect(TOPIC0.completed).toBe(
      '0x5f364ec8cbeb22a7121d682d8fbbf96032bfc28c76d26628d8562dfbb285b50a',
    )
    expect(TOPIC0.graduated).toBe(
      '0x18a56450d3c666e2bae9e0829fcada82a9ab0deef6e33c2496752c88d4155c9d',
    )
    expect(TOPIC0.deposited).toBe(
      '0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7',
    )
    expect(TOPIC0.claimed).toBe(
      '0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a',
    )
    expect(TOPIC0.transfer).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    )
  })

  it('literal degil HESAPLANIR', () => {
    for (const [kind, signature] of Object.entries(EVENT_SIGNATURES)) {
      expect(TOPIC0[kind as keyof typeof EVENT_SIGNATURES]).toBe(toEventSelector(signature))
    }
  })

  /**
   * INDEXER'IN BILEREK ISLEMEDIGI OLAYLAR.
   *
   * Bir olayi "tanimiyoruz" ile "islemiyoruz" ayrimi BURADA yazili olmak
   * zorunda: cekme katmani bilinmeyen bir `topic0`i sessizce atlar, yani liste
   * olmasa yeni bir olay hicbir yerde gorunmeden dusrulurdu.
   *
   * `FeeScheduleAssigned(address,address)` -- `contracts/` tarafi Faz 2'nin
   * mezuniyet sonrasi ucret tablosunu baglarken ekledi ve fixture'lara girdi.
   * Indexer onu BUGUN islemez: egri ustu ticaret ucretleri `Trade`in kendi
   * parcalarindan gelir, ve mezuniyet sonrasi havuz bu planin KAPSAMI
   * DISINDADIR (plan, "Kapsam disi"). Faz 2 indexlenmeye baslandiginda bu
   * satir SILINIR ve bir handler yazilir.
   */
  const DELIBERATELY_UNHANDLED: Record<string, string> = {
    '0xe027304f2e5e4d74279f1d1b4ac8f3d1916482aa45475d7dd67699ee58d8d479':
      'FeeScheduleAssigned(address,address) -- Faz 2 havuzu, kapsam disi',
  }

  // ILK YON: her fixture logu ya bizim tanidigimiz bir olaydir ya da BILEREK
  // islemedigimiz, ADIYLA yazili bir olaydir. Bir imza yanlis yazilirsa
  // hesaplanan selector hicbir gercek logla ortusmez; yeni bir olay eklendiginde
  // ise bu test kirilir ve ekleyeni KARAR VERMEYE zorlar.
  it('yerel fixture larin her logu ya tanidik ya da BILEREK islenmiyor', () => {
    for (const name of fixtureNames()) {
      for (const log of loadFixtureFile(name).logs) {
        const known = KIND_BY_TOPIC0.get(log.topics[0]!) !== undefined
        const declared = DELIBERATELY_UNHANDLED[log.topics[0]!] !== undefined
        expect(known || declared, `${name} logIndex ${log.logIndex} topic0=${log.topics[0]}`).toBe(
          true,
        )
      }
    }
  })

  // Ve "bilerek islenmiyor" listesi OLU OLMAMALI: icindeki her giris gercek
  // bir fixture logunda GORUNMELI, yoksa liste bir mazerete donusur.
  it('bilerek islenmeyen olaylarin her biri gercekten fixture larda var', () => {
    const seen = new Set(
      fixtureNames().flatMap((name) => loadFixtureFile(name).logs.map((l) => l.topics[0])),
    )
    for (const topic of Object.keys(DELIBERATELY_UNHANDLED)) {
      expect(seen.has(topic as `0x${string}`)).toBe(true)
    }
  })

  /**
   * FIXTURE'I HENUZ OLMAYAN OLAYLAR -- VE NEDEN, VE KIM KAPATIR.
   *
   * `contracts/fixtures/*.json` YALNIZCA `make fixtures` ile uretilir
   * (`FixtureGen.t.sol`, `vm.recordLogs()`), yani `forge` gerektirir. Bu izlek
   * `forge` KOSAMAZ (kontrat izlegi tek yetkilidir), dolayisiyla `Graduated`
   * icin gercek bir yurutme logu URETILEMEDI. Zincirden bir tane almak da
   * mumkun degil: `graduate()` YALNIZCA `graduationTarget`in kendisi
   * tarafindan cagrilabilir (`BondingCurve.sol:889`), uretim factory'sinde o
   * hedef sifirdir ve prova factory'sinde `0x…dEaD` -- yani kimsenin anahtari
   * olmayan bir adres.
   *
   * BOSLUK KAPATILMADI, ISIMLENDIRILDI, VE YERINE BASKA BIR KAPI KONDU. Bu
   * listedeki bir olayin imzasi asagida DERLENMIS ABI'ye karsi dogrulanir --
   * `packages/shared/src/abi/bondingCurve.ts`, ki `abi-parity` CI is'i onu
   * gercek bir `forge build` ciktisiyla IKI YONLU karsilastirir. Fixture'in
   * yaptigi is ("yanlis yazilmis bir imza hicbir gercek logla ortusmez") tam
   * olarak budur; kaybedilen sey, ODEME VE MIKTAR ALANLARININ gercek bir
   * yurutmeden gelmesidir.
   *
   * KAPATMA YOLU, TEK CUMLE: kontrat izlegi `FixtureGen.t.sol`e bir
   * `graduate()` senaryosu ekler, `make fixtures` kosar, ve bu giris SILINIR
   * -- asagidaki ikinci test onu silmeye ZORLAR.
   */
  const AWAITING_FIXTURE: Record<string, string> = {
    graduated:
      'Graduated -- `make fixtures` forge ister; bu izlek forge kosamaz ve zincirde ' +
      'graduate() yalnizca hedefin kendisi tarafindan cagrilabilir (uretimde hedef sifir, ' +
      'provada 0x…dEaD). Imza DERLENMIS ABI ile dogrulaniyor.',
    // UCU DE AYNI TEK OLGUYA BAGLI: zincirde henuz HICBIR HAVUZ YOK. Havuz
    // `ArcpadLocker.graduate()` icinde acilir, o da `graduationTarget`
    // gerektirir, o da uretimde `0x0`. Ilk gercek mezuniyet
    // 2026-08-11T23:01:51Z'de acilan pencerede olur; o gun bu uc giris de
    // SILINIR ve asagidaki iki test onu ZORLAR.
    poolSwap:
      'PoolManager.Swap -- zincirde henuz hicbir arcpad havuzu acilmadi (graduationTarget = 0x0). ' +
      'Imza `src/pool-events.generated.ts` uzerinden derlenmis ABI ile dogrulaniyor.',
    poolInitialize: 'PoolManager.Initialize -- ayni sebep; havuz ancak graduate() ile acilir.',
    poolFee:
      'ArcpadHook.SwapFeeCollected -- ayni sebep; hook ucreti ancak bir havuz swap inde tahsil eder.',
  }

  // IKINCI YON: her `TOPIC0` degeri en az bir gercek logda GORULUR. Yalnizca
  // birinci yon olsaydi, hic yayilmayan uydurma bir imza yesil kalirdi.
  it('her TOPIC0 degeri en az bir gercek logda gorulur', () => {
    const seen = new Set<string>()
    for (const name of fixtureNames()) {
      for (const log of loadFixtureFile(name).logs) seen.add(log.topics[0]!)
    }
    const missing = (Object.entries(TOPIC0) as [keyof typeof TOPIC0, string][])
      .filter(([kind, topic]) => !seen.has(topic) && AWAITING_FIXTURE[kind] === undefined)
      .map(([kind]) => kind)
    expect(missing).toEqual([])
  })

  // Ve muafiyet OLU OLAMAZ: fixture indigi anda giris SILINMEK ZORUNDA. Aksi
  // halde liste, kapandigini kimsenin fark etmedigi bir bosluga donusur --
  // bu depodaki `OPEN_CELLS` mekanizmasinin ayni kurali.
  //
  // TARAMA `contracts/fixtures/` ALTINDAKI HER JSON'A BAKAR, yalnizca ust
  // dizine DEGIL -- ve bu bir genisletme degil bir DUZELTMEDIR. `fixtureNames()`
  // ust dizini okur; oraya `make fixtures` yazar. Havuz olaylarinin ilk gercek
  // ornegi ise bu depoya CANLI BIR MAKBUZ olarak, `arc-live/` altina gelecek
  // (mezuniyet penceresi acildiginda). Ust dizine bakan bir kapi o gun
  // SESSIZCE yesil kalirdi -- yani muafiyet, tam da kapanmasi gereken anda
  // kapanmazdi.
  // TARAMANIN ERISIMI ICERIKTEN ISPATLANAMAZ, BU YUZDEN AYRICA OLCULUYOR.
  // OLCULDU (2026-08-09): `arc-live/`in yedi `topic0`i ust dizininkiyle TAM
  // OLARAK AYNI, yani "derin tarama daha cok sey buluyor" diye yazilmis bir
  // iddia bugun VAKUMDA gecerdi. Erisim dosya listesiyle olculur.
  it('tarama ic ice dizinlere de INER (erisim olculur, varsayilmaz)', () => {
    const files = fixtureJsonFiles()
    expect(files).toContain('arc-live/smoke-receipts.json')
    expect(files).toContain('launch.json')
    expect(files.length).toBeGreaterThan(fixtureNames().length)
  })

  it('fixture bekleyen her olay GERCEKTEN fixture larda yok', () => {
    const seen = allFixtureTopics()
    // ANTI-VAKUM: tarama gercekten log buluyor mu? Bos bir kume "hicbiri
    // fixture'larda yok" iddiasini bedavaya dogrularadi.
    expect(seen.size).toBeGreaterThan(3)
    expect(seen.has(TOPIC0.trade)).toBe(true)
    for (const kind of Object.keys(AWAITING_FIXTURE)) {
      const topic = TOPIC0[kind as keyof typeof TOPIC0]
      expect(topic, `${kind} bilinen bir olay degil`).toBeDefined()
      expect(
        seen.has(topic),
        `${kind} artik fixture'larda VAR; AWAITING_FIXTURE girisini SIL`,
      ).toBe(false)
    }
  })

  /**
   * IMZALARIN KAYNAGI: DERLENMIS ABI, ELLE YAZILMIS BIR TABLO DEGIL.
   *
   * `EVENT_SIGNATURES` elle yazilidir ve oyle kalmalidir (indexer `contracts/`
   * derlemesine bagimli OLAMAZ). Bu test o elle yazilmis dizgeleri
   * `packages/shared/src/abi/*`in -- deponun `forge build` ciktisina IKI YONLU
   * pinlenmis tek ABI kopyasi -- karsisina koyar. Fixture'i olmayan bir olay
   * icin TEK provenance kapisi budur; olani icin de ikinci bir kapidir.
   */
  it('her imza DERLENMIS ABI den yeniden turetilebilir', () => {
    const CONTRACT_OF: Partial<Record<keyof typeof EVENT_SIGNATURES, readonly unknown[]>> = {
      launched: launchFactoryAbi,
      trade: bondingCurveAbi,
      completed: bondingCurveAbi,
      graduated: bondingCurveAbi,
      deposited: feeEscrowAbi,
      claimed: feeEscrowAbi,
      transfer: launchTokenAbi,
      // UC HAVUZ OLAYI BASKA BIR KAYNAKTAN GELIR VE BU BILINCLI. Otekiler
      // `packages/shared/src/abi/*`tan okunur -- `abi-parity` CI is'inin
      // artifact ile IKI YONLU karsilastirdigi kopya. Havuz olaylari icin ayni
      // yol yanlis takas olurdu: `abi-parity` TAM ABI karsilastirir, yani
      // `PoolManager`in 52 girisi de oraya kopyalanmali; ve `ARCPAD_ERROR_ABI`
      // o dosyalardan beslendigi icin V4/hook hatalari frontend'in hata
      // sozlugune sizardi. Bunun yerine `sync-pool-events` ayni artifact'tan
      // YALNIZCA uc olayi cikarir ve `src/pool-events.generated.ts` olarak
      // COMMIT'ler -- provenance ayni yerden, kapsam dar.
      poolSwap: [POOL_MANAGER_SWAP_EVENT],
      poolInitialize: [POOL_MANAGER_INITIALIZE_EVENT],
      poolFee: [ARCPAD_HOOK_SWAP_FEE_COLLECTED_EVENT],
    }
    // Bos kume uzerinde "hepsi gecti" dogru olurdu; sayi sabitlenir.
    expect(Object.keys(CONTRACT_OF).length).toBe(Object.keys(EVENT_SIGNATURES).length)

    for (const [kind, signature] of Object.entries(EVENT_SIGNATURES)) {
      const abi = CONTRACT_OF[kind as keyof typeof EVENT_SIGNATURES]
      expect(abi, `${kind} icin ABI secilmemis`).toBeDefined()
      const name = signature.slice(0, signature.indexOf('('))
      const entry = (abi as { type: string; name?: string; inputs?: { type: string }[] }[]).find(
        (e) => e.type === 'event' && e.name === name,
      )
      expect(entry, `${name} derlenmis ABI'de yok`).toBeDefined()
      const derived = `${name}(${entry?.inputs?.map((i) => i.type).join(',') ?? ''})`
      expect(derived, kind).toBe(signature)
    }
  })

  /**
   * `Graduated`IN INDEKSLI ALANLARI DA ABI'DEN OLCULUR.
   *
   * Bir imza dogru olup indeksleme YANLIS olabilir: `topic0` yalnizca
   * tiplerden hesaplanir, `indexed` bayraklarindan degil. Cozucu iki topic
   * bekler (`expect('graduated', log, 3, 2)`) ve iki data kelimesi; bu sayilar
   * dogrudan asagidaki bayraklardan cikar. Yanlis bir varsayim burada
   * yakalanir, uretimde `MalformedLog` olarak degil.
   */
  it('Graduated in indeksli alanlari ABI de token ve to dur', () => {
    const entry = (
      bondingCurveAbi as unknown as {
        type: string
        name?: string
        inputs?: { name: string; indexed?: boolean }[]
      }[]
    ).find((e) => e.type === 'event' && e.name === 'Graduated')
    expect(entry?.inputs?.map((i) => `${i.name}:${i.indexed === true}`)).toEqual([
      'token:true',
      'to:true',
      'baseAmount:false',
      'quoteAmount:false',
    ])
  })

  // UCUNCU: CANLI zincir. Yerel fixture'lar Foundry'den, bunlar Arc'tan.
  it('canli Arc makbuzlarindaki her sozlesme logu da tanidiktir', () => {
    for (const receipt of loadSmoke().receipts) {
      for (const log of receipt.logs) {
        if (isForbiddenEmitter(log.address)) continue
        expect(
          KIND_BY_TOPIC0.get(log.topics[0]!),
          `${receipt.scenario} ${log.logIndex}`,
        ).toBeDefined()
      }
    }
  })
})

describe('yasakli emitter kumesi', () => {
  it('tam olarak iki adres tasir', () => {
    expect([...FORBIDDEN_TRANSFER_EMITTERS].sort()).toEqual([
      '0x3600000000000000000000000000000000000000',
      '0xfffffffffffffffffffffffffffffffffffffffe',
    ])
  })

  // Adres kucuk/buyuk harf duyarli bir dizge olarak saklanir; kume uyeligi de
  // oyle. Buyuk harfli bir giris duvari SESSIZCE etkisiz kilardi.
  it('buyuk harfli yazim da yakalanir', () => {
    expect(isForbiddenEmitter(EIP7708_SYSTEM_EMITTER.toUpperCase())).toBe(true)
    expect(isForbiddenEmitter('0x3600000000000000000000000000000000000000'.toUpperCase())).toBe(
      true,
    )
  })

  it('canli smoke un 7708 yayincisi tam olarak bu kumededir', () => {
    const smoke = loadSmoke()
    expect(isForbiddenEmitter(smoke.nativeTransferEmitter)).toBe(true)
    // Ve o yayinci canli makbuzlarda GERCEKTEN var -- yoksa bu duvar
    // test edilmemis bir kod yolu olurdu.
    const count = smoke.receipts
      .flatMap((r) => r.logs)
      .filter((l) => isForbiddenEmitter(l.address)).length
    expect(count).toBe(12)
  })

  // Bir launch token'i yasakli olamaz: olsaydi butun bakiyeleri duserdi.
  it('canli launch token yasakli DEGILDIR', () => {
    expect(isForbiddenEmitter('0x1bd93613a7bc470a739d9615cdc65e535d958fab')).toBe(false)
  })
})

describe('olculmus RPC sinirlari', () => {
  it('sabitler olculmus degerlerdir', () => {
    expect(ARC_GETLOGS_MAX_RESULTS).toBe(20_000)
    // 1.000 kabul edildi; yarisinda duruyoruz.
    expect(ADDRESS_FILTER_CHUNK).toBe(500)
  })
})
