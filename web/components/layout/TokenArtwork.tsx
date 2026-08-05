'use client'

import { useState } from 'react'
import { cx } from '@/components/ui/cx'
import { ipfsPathPrefix } from '@/lib/ipfs'

/**
 * `next/image` KULLANILMIYOR, ve gerekcesi uc somut madde:
 *
 * (a) `pnpm-workspace.yaml` `sharp: false` diyor ve Faz 0 bunu "Faz 4'te
 *     tekrar bak" diye kaydetti. Next'in optimize edicisini calistirmak icin
 *     sharp'in kurulum betigine izin vermek gerekir; bu kabuk hicbir gorseli
 *     yeniden olceklemeden calistigi icin o izni almanin karsiligi yok.
 *
 * (b) Rastgele IPFS gorsellerini KENDI ORIGIN'IMIZDEN gecirmek bir kotuye
 *     kullanim yoludur: olceklenmesi bize maliyet, icerigi bize itibar. Bir
 *     launch'in "gorseli" kullanicidan gelir ve moderasyonu yoktur.
 *
 * (c) Kart izgarasi 1:1 SABIT kutudur. Optimize edicinin cozdugu problem
 *     (bilinmeyen oran, bilinmeyen boyut, layout kaymasi) bizde zaten yok.
 *
 * Yerine: sabit oranli kutu + `loading="lazy" decoding="async"
 * referrerPolicy="no-referrer"`, izinli tek gateway, ve HER ZAMAN deterministik
 * bir yedek.
 */

/**
 * TEK IZINLI GATEWAY. Bir liste degil bir deger: `ipfs://` bir host tasimaz,
 * dolayisiyla "kullanicinin verdigi gateway" diye bir sey yoktur ve olsaydi
 * acik bir yonlendirme yuzeyi olurdu.
 *
 * ARTIK BIR SABIT DEGIL, CUNKU SABIT OLMASI CANLI BIR KUSURDU. Burada
 * `'https://ipfs.io/ipfs/'` yaziyordu; `next.config.ts`in CSP'si ve
 * `lib/metadata.ts` ise `NEXT_PUBLIC_IPFS_GATEWAY`i OKUYORDU. Yani gateway'i
 * degistiren bir operatorde `img-src` yeni origin'e aciliyor, gorseller ise
 * hâlâ ipfs.io'dan isteniyordu: BUTUN TOKEN GORSELLERI kendi CSP'miz
 * tarafindan reddedilir. Cozum `web/lib/ipfs.ts`, tek kaynak.
 */
export function ipfsGateway(): string {
  return ipfsPathPrefix()
}

/** FNV-1a. Adres olmayan bir tohum icin deterministik 8 nibble uretir. */
function seedHex(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export type TokenGradient = { from: string; to: string; angle: number }

/**
 * YEDEK BIR "KIRIK GORSEL" DEGILDIR. Gorseli olmayan launch YAYGIN DURUMDUR --
 * `uri` bos ya da cozulemez oldugunda ekranda kirik bir ikon degil, o token'a
 * AIT bir isaret durmali.
 *
 * Renkler adresten turetilir, yani ayni token her yerde ayni sviciyle cizilir
 * ve kullanici bir listeyi tararken bir token'i adini okumadan taniyabilir.
 * Arc'ta ENS yok; adres kimligin kendisi, dolayisiyla kimligi resmeden seyin
 * adresten turemesi keyfi degil.
 *
 * `oklch` secildi cunku sRGB'de esit araliklı hue'lar esit PARLAKLIK vermez:
 * sari-yesil bandi mor banda gore gozle ucar ve yari yedekler paletle kavga
 * eder. oklch'te aciklik sabit tutuldugunda uretilen her cift ayni agirlikta
 * durur.
 */
export function tokenGradient(address: string): TokenGradient {
  const hex = /^0x[0-9a-fA-F]{40}$/.test(address)
    ? address.slice(2).toLowerCase()
    : seedHex(address)

  const from = Number.parseInt(hex.slice(0, 4).padEnd(4, '0'), 16) % 360
  // En az 42 derece ayrim: bitisik iki hue'dan olusan gradyan duz bir zemin
  // gibi gorunur ve svic ayirt edici olmaktan cikar.
  const spread = 42 + (Number.parseInt(hex.slice(4, 6).padEnd(2, '0'), 16) % 128)
  const to = (from + spread) % 360
  const angle = (Number.parseInt(hex.slice(6, 8).padEnd(2, '0'), 16) % 8) * 45

  return { from: `oklch(0.68 0.15 ${from})`, to: `oklch(0.30 0.09 ${to})`, angle }
}

/**
 * `ipfs://CID/yol` -> izinli gateway. `https:` gecer. BASKA HER SEY REDDEDILIR
 * ve `null` doner: `data:` ve `javascript:` bir <img>'de zararsiz gorunur ama
 * `uri` zincirden, yani bir yabancidan gelir ve bir gun `<img>` disinda bir
 * yere de verilebilir. Reddi kaynakta yapmak, ileride nereye verildiginden
 * bagimsiz olarak dogru kalir.
 */
export function resolveArtworkSrc(uri: string | null | undefined): string | null {
  if (!uri) return null
  const value = uri.trim()
  if (value.startsWith('ipfs://')) {
    const path = value.slice('ipfs://'.length).replace(/^ipfs\//, '')
    return path ? `${ipfsGateway()}${path}` : null
  }
  return value.startsWith('https://') ? value : null
}

export type TokenArtworkProps = {
  /** Yedegin tohumu. Token adresi. */
  address: string
  /**
   * Bu token icin kayitli GORSEL adresi (`ipfs://…` / `https://…`), ya da yok.
   *
   * DIKKAT: zincirdeki `uri` metadata JSON'unu gosterir, gorseli degil. O
   * JSON'u cozup `image` alanini cikarmak okuma katmaninin isi (Task 7); bu
   * bilesen cozulmus degeri alir.
   */
  uri?: string | null
  /** Kenar uzunlugu (px) ya da `'fill'` -- ebeveyni dolduran 1:1 kutu. */
  size?: number | 'fill'
  /** Yedegin uzerindeki monogram. Token sembolu. */
  symbol?: string
  className?: string
}

export function TokenArtwork({ address, uri, size = 48, symbol, className }: TokenArtworkProps) {
  const src = resolveArtworkSrc(uri)
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)
  const gradient = tokenGradient(address)
  const showImage = src !== null && brokenSrc !== src

  return (
    <span
      data-testid="token-artwork"
      className={cx(
        'relative block shrink-0 overflow-hidden rounded-input border border-border',
        size === 'fill' && 'aspect-square w-full',
        className,
      )}
      style={{
        ...(size === 'fill' ? {} : { width: size, height: size }),
        // Yedek HER ZAMAN cizilir ve gorselin altinda durur: gorsel gec
        // yuklendiginde ya da hic gelmediginde kutu bos bir dikdortgen olmaz.
        backgroundImage: `linear-gradient(${gradient.angle}deg, ${gradient.from}, ${gradient.to})`,
      }}
    >
      {!showImage && symbol ? (
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center font-serif leading-none text-black/45"
          style={{ fontSize: size === 'fill' ? '38%' : Math.round(size * 0.42) }}
        >
          {symbol.slice(0, 2).toUpperCase()}
        </span>
      ) : null}

      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setBrokenSrc(src)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : null}
    </span>
  )
}
