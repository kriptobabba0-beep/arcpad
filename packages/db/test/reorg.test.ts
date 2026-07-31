import { describe, expect, it } from 'vitest'
import { assertContinuous, ReorgDetected } from '../src/reorg'

const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

/**
 * SAF muhafizin kendisi. Veritabani ISTEMEZ, bu yuzden `setup.ts`in acilis
 * maliyetini de odemez -- ama `packages/db` icinde durur, cunku muhafizin evi
 * artik burasi: `replayRange` onu cagirmadan imleci ilerletemiyor.
 */
describe('assertContinuous', () => {
  it('ilk kosuda karsilastiracak bir sey yoktur', () => {
    expect(() => assertContinuous(0n, null, H(0xdead))).not.toThrow()
  })

  it('bag saglamsa gecer', () => {
    expect(() => assertContinuous(100n, H(0xaa), H(0xaa))).not.toThrow()
  })

  it('buyuk/kucuk harf farki bir reorg DEGILDIR', () => {
    // RPC'ler hash'i buyuk harfli dondurebilir; bunu reorg saymak her turu
    // durdururdu.
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
    // davranisi -- imleci geri almak, satir silmek -- YOKTUR ve olmamalidir.
    // Iki sebep: reorg uretmeyen bir zincirde o yolu hicbir sey egzersiz
    // etmez, VE geri sarma hicbir gozlemin sinirlamadigi bir derinlik tahmin
    // etmek zorundadir; yanlis bir tahmin veritabanini ONARILMIS GORUNURKEN
    // yeni bir bicimde sessizce yanlis birakir. Durmanin boyle bir kipi yok.
    expect(assertContinuous(1n, H(1), H(1))).toBeUndefined()
    expect(() => assertContinuous(1n, H(1), H(2))).toThrow(ReorgDetected)
  })

  // Tek nokta degil AILE.
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
