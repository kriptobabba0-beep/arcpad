import { describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'
import {
  ARC_GETLOGS_MAX_RANGE,
  assertContinuous,
  finalizedHead,
  nextRange,
  ReorgDetected,
} from '../src/cursor'

describe('nextRange', () => {
  it('imlec head ile ayniysa islenecek bir sey yoktur', () => {
    expect(nextRange(100n, 100n, 1000n)).toBeNull()
  })

  it('imlec head gerisindeyse imlecten sonraki bloktan baslar', () => {
    expect(nextRange(100n, 150n, 1000n)).toEqual({ from: 101n, to: 150n })
  })

  it('araligi maxSpan ile sinirlar', () => {
    expect(nextRange(0n, 10_000n, 500n)).toEqual({ from: 1n, to: 500n })
  })

  it('head imlecin gerisine duserse null doner (yeniden baglanma guvenligi)', () => {
    expect(nextRange(200n, 150n, 1000n)).toBeNull()
  })

  it('tam olarak maxSpan kadar blok kaldiginda tek aralikta bitirir', () => {
    expect(nextRange(0n, 500n, 500n)).toEqual({ from: 1n, to: 500n })
  })

  it('maxSpan sifir ise reddeder (ters aralik uretmez)', () => {
    expect(() => nextRange(0n, 10n, 0n)).toThrow(RangeError)
  })

  it('maxSpan negatif ise reddeder', () => {
    expect(() => nextRange(0n, 10n, -1n)).toThrow(RangeError)
  })

  it("Arc'in 10.000 blok sinirinin uzerindeki maxSpan i reddeder", () => {
    expect(() => nextRange(0n, 100_000n, 10_001n)).toThrow(/10000/)
    expect(nextRange(0n, 100_000n, 10_000n)).toEqual({ from: 1n, to: 10_000n })
  })

  // EN DAR SINIR: head, maxSpan'in tam BIR fazlasi kadar ileride. Bu, kismalı
  // dalin en kucuk halidir ve Faz 0'da hic sabitlenmemisti.
  it('head == cursor + maxSpan + 1 iken tam maxSpan kadar isler', () => {
    expect(nextRange(100n, 601n, 500n)).toEqual({ from: 101n, to: 600n })
  })

  it('bir blok kaldiginda tek bloklu aralik dondurur', () => {
    expect(nextRange(100n, 101n, 500n)).toEqual({ from: 101n, to: 101n })
  })

  // Gozden geciren bunu KODU OKUYARAK isaretledi, calistirmadi. Burada
  // calistiriliyor: eski govdede nextRange(-5n, 10n, 5n) `{from: -4n, to: 0n}`
  // donduruyordu -- sifirin altinda bir blok numarasi.
  it('negatif cursor u reddeder', () => {
    expect(() => nextRange(-5n, 10n, 5n)).toThrow(RangeError)
    expect(() => nextRange(-1n, 10n, 5n)).toThrow(/cursor negatif/)
    // Sinirin dogru tarafi: sifir MESRU bir imlectir (henuz hicbir sey
    // islenmedi) ve genesis'ten sonraki bloktan baslar.
    expect(nextRange(0n, 3n, 5n)).toEqual({ from: 1n, to: 3n })
  })

  it('negatif cursor lar ailesinin TAMAMI reddedilir', () => {
    // Tek nokta degil aile: -1..-50, uc ayri head ve uc ayri maxSpan ile.
    let cases = 0
    for (let c = -1n; c >= -50n; c--) {
      for (const head of [-10n, 0n, 100n]) {
        for (const span of [1n, 7n, 10_000n]) {
          cases++
          expect(() => nextRange(c, head, span)).toThrow(RangeError)
        }
      }
    }
    expect(cases).toBe(450)
  })

  it('gecerli maxSpan araliginin IKI ucunu da sabitler', () => {
    // Alt uc: 1. Ust uc: ARC_GETLOGS_MAX_RANGE. Ikisi de gecmeli; bir adim
    // disarilari yukaridaki iki test tarafindan reddediliyor.
    expect(nextRange(0n, 5n, 1n)).toEqual({ from: 1n, to: 1n })
    expect(nextRange(0n, 1n, ARC_GETLOGS_MAX_RANGE)).toEqual({ from: 1n, to: 1n })
  })

  // ---------------------------------------------------------------
  // KAPSAM OLCULUR, VARSAYILMAZ.
  //
  // Yukaridaki ornekler tek tek noktalar. Bir orneklem DEGIL, sinirli bir
  // ailenin TAMAMI taranir: cursor 0..24, head 0..24, maxSpan 1..12 --
  // 25*25*12 = 7500 cagri, hepsi deterministik. Sayimin kendisi iddia edilir
  // ki dongu sinirlarini kucultmek testi sessizce zayiflatamasin.
  // ---------------------------------------------------------------
  it('7500 kombinasyonun tamaminda dort degismez korunur', () => {
    let calls = 0
    let ranges = 0
    let nulls = 0
    let clamped = 0

    for (let cursor = 0n; cursor <= 24n; cursor++) {
      for (let head = 0n; head <= 24n; head++) {
        for (let maxSpan = 1n; maxSpan <= 12n; maxSpan++) {
          calls++
          const r = nextRange(cursor, head, maxSpan)

          if (head <= cursor) {
            nulls++
            expect(r).toBeNull()
            continue
          }

          ranges++
          if (r === null) throw new Error(`beklenmeyen null: ${cursor} ${head} ${maxSpan}`)
          // 1. Bosluk yok: her zaman imlecten SONRAKI blokta baslar.
          expect(r.from).toBe(cursor + 1n)
          // 2. Bos ya da ters aralik yok.
          expect(r.to).toBeGreaterThanOrEqual(r.from)
          // 3. head asilmaz.
          expect(r.to).toBeLessThanOrEqual(head)
          // 4. maxSpan asilmaz.
          expect(r.to - r.from + 1n).toBeLessThanOrEqual(maxSpan)

          if (r.to < head) clamped++
        }
      }
    }

    expect(calls).toBe(7500)
    // Aile GERCEKTEN her iki dali de geziyor mu? Sayilar bunu olcer; "kapsandi
    // sanilan" dal boyle yakalanir.
    expect(nulls).toBe(3900)
    expect(ranges).toBe(3600)
    expect(clamped).toBe(2014)
  })

  it('ardisik turlar bosluk da ortusme de birakmaz', () => {
    // Tek bir noktayi degil, ILERLEYISI sabitler: 0'dan 5000'e 7'lik
    // adimlarla yurunur ve her aralik bir oncekinin bittigi yerin hemen
    // ardindan baslar.
    let cursor = 0n
    const head = 5_000n
    const seen: bigint[] = []
    for (;;) {
      const r = nextRange(cursor, head, 7n)
      if (r === null) break
      expect(r.from).toBe(cursor + 1n)
      for (let b = r.from; b <= r.to; b++) seen.push(b)
      cursor = r.to
    }
    expect(cursor).toBe(head)
    expect(seen).toHaveLength(5000)
    expect(seen[0]).toBe(1n)
    expect(seen[4999]).toBe(5000n)
    expect(new Set(seen).size).toBe(5000)
  })
})

describe('assertContinuous -- reorg tutulmasini onleyen muhafiz', () => {
  const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

  it('ilk kosuda karsilastiracak bir sey yoktur', () => {
    expect(() => assertContinuous(0n, null, H(0xdead))).not.toThrow()
  })

  it('bag saglamsa gecer', () => {
    expect(() => assertContinuous(100n, H(0xaa), H(0xaa))).not.toThrow()
  })

  it('buyuk/kucuk harf farki bir reorg DEGILDIR', () => {
    // RPC'ler hash'i checksum'siz ama buyuk harfli dondurebilir; bunu reorg
    // saymak her turu durdururdu.
    expect(() => assertContinuous(100n, H(0xab), H(0xab).toUpperCase())).not.toThrow()
  })

  it('bag kopmussa DURUR ve hangi bloktan bahsettigini soyler', () => {
    let caught: unknown
    try {
      assertContinuous(54_325_469n, H(0xaa), H(0xbb))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ReorgDetected)
    const e = caught as ReorgDetected
    // Ayirt edilebilir bir tip: gecici bir RPC hatasi yeniden denenir, bu
    // denenmez.
    expect(e.name).toBe('ReorgDetected')
    expect(e.cursor).toBe(54_325_469n)
    expect(e.expectedParentHash).toBe(H(0xaa))
    expect(e.actualParentHash).toBe(H(0xbb))
    // Mesaj, bakan kisiye SONRAKI blogun numarasini verir.
    expect(e.message).toContain('54325470')
  })

  it('KENDINI ONARMAZ -- bu bir iddia, bir geri sarma degil', () => {
    // Muhafizin sozlesmesi: ya sessizce gecer ya da firlatir. Ucuncu bir
    // davranisi -- imleci geri almak, satir silmek -- YOKTUR ve olmamalidir:
    // reorg uretmeyen bir zincirde o yolu hicbir sey egzersiz etmez.
    expect(assertContinuous(1n, H(1), H(1))).toBeUndefined()
    expect(() => assertContinuous(1n, H(1), H(2))).toThrow(ReorgDetected)
  })

  // Tek nokta degil AILE: imlecten farkli derinliklerde kopan baglar.
  it('bagin koptugu HER durumda durur, saglam oldugu HER durumda gecer', () => {
    let broken = 0
    let intact = 0
    for (let c = 0n; c < 40n; c++) {
      for (let stored = 0; stored < 5; stored++) {
        for (let seen = 0; seen < 5; seen++) {
          const call = () => assertContinuous(c, H(stored), H(seen))
          if (stored === seen) {
            intact++
            expect(call).not.toThrow()
          } else {
            broken++
            expect(call).toThrow(ReorgDetected)
          }
        }
      }
    }
    expect(intact).toBe(200)
    expect(broken).toBe(800)
  })
})

describe('ARC_GETLOGS_MAX_RANGE -- iki kaynak riski', () => {
  // Sabitin normal evi `@arcpad/shared` (plan Task 1). O paket baska bir ajanin
  // elinde oldugu icin deger burada, bu taskin sinirinda tanimlandi. Task 1
  // indi ve `@arcpad/shared` sabiti HALA yayinlamiyor -- yani sapma mesru
  // kaldi. Ama shared bir gun onu yayinlarsa IKI KAYNAK olur ve ikisi sessizce
  // ayrilabilir.
  //
  // Bu test o gunu bir HATAYA cevirir: kirildiginde yapilacak sey belli --
  // `cursor.ts`teki yerel `const`i `export { ARC_GETLOGS_MAX_RANGE } from
  // '@arcpad/shared'` ile degistirmek ve bu testi silmek.
  it('shared bu sabiti HENUZ yayinlamiyor; yayinladigi gun bu test kirilir', async () => {
    const shared = (await import('@arcpad/shared')) as Record<string, unknown>
    expect(Object.hasOwn(shared, 'ARC_GETLOGS_MAX_RANGE')).toBe(false)
    // Tek kaynak bugun burasi ve degeri olculmus sinirdir.
    expect(ARC_GETLOGS_MAX_RANGE).toBe(10_000n)
  })
})

describe('finalizedHead', () => {
  /** viem'in `PublicClient`'inin yalnizca `getBlock`'unu tasiyan sahte istemci. */
  function fakeClient(byTag: Record<string, bigint>) {
    const getBlock = vi.fn(async ({ blockTag }: { blockTag: string }) => {
      const number = byTag[blockTag]
      if (number === undefined) throw new Error(`sahte istemcide etiket yok: ${blockTag}`)
      return { number }
    })
    return { client: { getBlock } as unknown as PublicClient, getBlock }
  }

  it("`finalized` etiketini okur, `latest`'i DEGIL", async () => {
    const { client, getBlock } = fakeClient({ latest: 54_326_390n, finalized: 54_326_391n })
    await expect(finalizedHead(client)).resolves.toBe(54_326_391n)
    expect(getBlock).toHaveBeenCalledTimes(1)
    expect(getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' })
  })

  it("OLCULMUS tutarsizlikta latest'e DUSMEZ (finalized > latest)", async () => {
    // Gercek okuma: latest 54326390, finalized 54326391. `latest`'e dusen bir
    // uygulama burada BIR blok geride kalir ve o blogun loglari, imlec
    // ilerledigi icin bir daha hic taranmaz.
    const { client } = fakeClient({ latest: 54_326_390n, finalized: 54_326_391n })
    const head = await finalizedHead(client)
    expect(head).not.toBe(54_326_390n)
  })

  it('finalized geriye duserse deger oldugu gibi doner; yutma yeri nextRange', async () => {
    // Iki ardisik okuma: 54326391 sonra 54326388. `finalizedHead` bunu
    // DUZELTMEZ -- duzeltmek, head'in tek kaynagi olma sozunu bozardi.
    const a = fakeClient({ finalized: 54_326_391n })
    const b = fakeClient({ finalized: 54_326_388n })
    expect(await finalizedHead(a.client)).toBe(54_326_391n)
    expect(await finalizedHead(b.client)).toBe(54_326_388n)
    // Geriye dusmus head, imlec ilerledikten sonra bos donguye cevrilir.
    expect(nextRange(54_326_391n, 54_326_388n, 1_000n)).toBeNull()
  })

  it('`safe` etiketini de kullanmaz', async () => {
    // Olculen ucuncu satir: latest 54326393, finalized 54326393, safe
    // 54326394. `safe`, `finalized`'in ONUNDE gorulebildi.
    const { client, getBlock } = fakeClient({
      latest: 54_326_393n,
      finalized: 54_326_393n,
      safe: 54_326_394n,
    })
    await expect(finalizedHead(client)).resolves.toBe(54_326_393n)
    expect(getBlock).not.toHaveBeenCalledWith({ blockTag: 'safe' })
  })
})
