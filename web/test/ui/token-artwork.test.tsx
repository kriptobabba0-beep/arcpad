import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  ipfsGateway,
  resolveArtworkSrc,
  TokenArtwork,
  tokenGradient,
} from '@/components/layout/TokenArtwork'

const SMOKE_TOKEN = '0x1bd93613a7BC470a739D9615cdc65e535d958fab'
const SMOKE_CURVE = '0x7938BE340A14A12f94a83AEa246d9d2566324c9C'

describe('tokenGradient', () => {
  it('ayni adres her yerde ayni svici verir', () => {
    expect(tokenGradient(SMOKE_TOKEN)).toEqual(tokenGradient(SMOKE_TOKEN))
  })

  it('buyuk/kucuk harf farki svici degistirmez -- EIP-55 ile ayni token', () => {
    expect(tokenGradient(SMOKE_TOKEN.toLowerCase())).toEqual(
      tokenGradient(SMOKE_TOKEN.toUpperCase().replace('0X', '0x')),
    )
  })

  it('farkli adresler farkli svic verir', () => {
    expect(tokenGradient(SMOKE_TOKEN)).not.toEqual(tokenGradient(SMOKE_CURVE))
  })

  it('iki hue arasinda en az 42 derece ayrim birakir', () => {
    // Bitisik iki hue'dan olusan gradyan duz bir zemin gibi gorunur ve svic
    // ayirt edici olmaktan cikar.
    for (const address of [SMOKE_TOKEN, SMOKE_CURVE, '0x' + '0'.repeat(40)]) {
      const { from, to } = tokenGradient(address)
      const hue = (value: string) => Number(/oklch\([^ ]+ [^ ]+ ([\d.]+)\)/.exec(value)?.[1])
      const delta = Math.abs(hue(from) - hue(to))
      expect(Math.min(delta, 360 - delta)).toBeGreaterThanOrEqual(42)
    }
  })

  it('adres olmayan bir tohumda da cizer, atmaz', () => {
    expect(tokenGradient('SMOKE').from).toMatch(/^oklch\(/)
  })
})

describe('resolveArtworkSrc', () => {
  /**
   * SOLDA SABIT BIR DIZE VAR, `ipfsGateway()` DEGIL -- ve bu fark onemli.
   *
   * Onceki hal `\`${IPFS_GATEWAY}bafyfoo/image.png\`` ile karsilastiriyordu,
   * yani iddia OLCTUGU KODUN KENDISINDEN turetiliyordu: gateway ne olursa
   * olsun test yesildi ve sabit yanlis bir degere donse bile hicbir sey
   * soylemezdi. Beklenen deger burada ACIKCA yaziliyor.
   *
   * VE ARTIK BEKLENEN DEGER BIR GATEWAY DEGIL. Canli sunucuda olculdu:
   * gateway CID'i `application/octet-stream` ile servis edince Chrome gorseli
   * ORB ile atiyor (`net::ERR_BLOCKED_BY_ORB`) ve kullanicinin az once
   * yukledigi logo sessizce yok oluyor. Cevabin bizim orijinimizden gelmesi
   * gerekiyordu; `/api/ipfs/…` baytlara bakip tipi kendisi soyler.
   */
  it('ipfs:// kendi vekilimize cevrilir', () => {
    expect(resolveArtworkSrc('ipfs://bafyfoo/image.png')).toBe('/api/ipfs/bafyfoo/image.png')
    // ...ve bu, bilesenin kullandigi AYNI onektir.
    expect(resolveArtworkSrc('ipfs://bafyfoo/image.png')).toBe(`${ipfsGateway()}bafyfoo/image.png`)
  })

  /**
   * BIR GATEWAY URL'I VEKILE YAZILIR, YABANCI BIR HOST ISE REDDEDILIR.
   *
   * Once her `https:` adresi oldugu gibi geciyordu. Gecmesinin bir anlami
   * yoktu: CSP `img-src` yalnizca gateway'e acikti, yani ucuncu bir hosttan
   * gelen gorsel zaten tarayici tarafindan reddediliyordu -- ama once KIRIK
   * bir `<img>` cizilip sonra yedege duselerek. Kaynakta reddetmek ayni
   * zamanda her ziyaretcinin IP'sini o hosta sizdiran istegi de yok eder.
   */
  it("gateway url'i vekile yazilir, yabanci host reddedilir", () => {
    expect(resolveArtworkSrc('https://gateway.pinata.cloud/ipfs/bafyfoo/a.png')).toBe(
      '/api/ipfs/bafyfoo/a.png',
    )
    expect(resolveArtworkSrc('https://example.test/a.png')).toBeNull()
    // Dogru host, ama `/ipfs/` disinda bir yol: bu bir CID degil.
    expect(resolveArtworkSrc('https://gateway.pinata.cloud/admin')).toBeNull()
  })

  it('http, data ve javascript REDDEDILIR', () => {
    // `uri` zincirden, yani bir yabancidan gelir. Reddi kaynakta yapmak,
    // degerin ileride nereye verildiginden bagimsiz olarak dogru kalir.
    expect(resolveArtworkSrc('http://example.test/a.png')).toBeNull()
    expect(resolveArtworkSrc('data:image/svg+xml;base64,AAAA')).toBeNull()
    expect(resolveArtworkSrc('javascript:alert(1)')).toBeNull()
  })

  it('bos ve tanimsiz deger null verir', () => {
    expect(resolveArtworkSrc('')).toBeNull()
    expect(resolveArtworkSrc(null)).toBeNull()
    expect(resolveArtworkSrc(undefined)).toBeNull()
  })
})

describe('<TokenArtwork>', () => {
  it('gorseli olmayan launch KIRIK GORSEL degil, o token’a ait bir svic cizer', () => {
    render(<TokenArtwork address={SMOKE_TOKEN} symbol="SMOKE" />)

    const box = screen.getByTestId('token-artwork')
    expect(box.querySelector('img')).toBeNull()
    expect(box.getAttribute('style')).toContain('linear-gradient')
    expect(box).toHaveTextContent('SM')
  })

  it('gorsel varken next/image DEGIL, tembel yuklenen bir <img> cizer', () => {
    render(<TokenArtwork address={SMOKE_TOKEN} uri="ipfs://bafyfoo/image.png" />)

    const img = screen.getByTestId('token-artwork').querySelector('img')
    expect(img).not.toBeNull()
    expect(img).toHaveAttribute('src', '/api/ipfs/bafyfoo/image.png')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img).toHaveAttribute('decoding', 'async')
    // Rastgele bir IPFS gateway'ine kendi URL'imizi sizdirmayiz.
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer')
    // Bitisik metin token adini zaten tasir; ikinci kez okutmak gurultu.
    expect(img).toHaveAttribute('alt', '')
  })

  it('yedek gorselin ALTINDA her zaman durur -- kutu hicbir an bos degildir', () => {
    render(<TokenArtwork address={SMOKE_TOKEN} uri="https://example.test/a.png" />)
    expect(screen.getByTestId('token-artwork').getAttribute('style')).toContain('linear-gradient')
  })

  it('reddedilen bir uri sessizce yedege duser', () => {
    render(<TokenArtwork address={SMOKE_TOKEN} uri="http://example.test/a.png" symbol="SMOKE" />)
    expect(screen.getByTestId('token-artwork').querySelector('img')).toBeNull()
  })

  it('1:1 sabit kutu -- optimize edicinin cozdugu problem bizde yok', () => {
    render(<TokenArtwork address={SMOKE_TOKEN} size="fill" />)
    expect(screen.getByTestId('token-artwork').className).toContain('aspect-square')
  })
})
