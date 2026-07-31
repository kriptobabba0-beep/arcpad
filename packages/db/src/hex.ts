/**
 * `0x` + onaltilik. `viem`'in `Address`'iyle YAPISAL OLARAK AYNI ama viem'e
 * BAGIMLI DEGIL: `@arcpad/db`'nin tek calisma zamani bagimliligi `pg`'dir ve
 * oyle kalmalidir -- semanin okuyucusu (`web`) yazicinin surec bagimliliklarini
 * kurmak zorunda kalmasin diye bu paket zaten ayrildi.
 */
export type Address = `0x${string}`

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * Semanin `CHECK (... ~ '^0x[0-9a-f]{40}$')` deseninin TypeScript tarafindaki
 * karsiligi. Adresi KUCUK HARFE indirger.
 *
 * NICIN KUCUK HARF: EIP-55 checksum'li bir adres ile ayni adresin kucuk harfli
 * hali IKI FARKLI text degeridir. Birini `launches.token`'a, digerini
 * `trades.token`'a yazmak yabanci anahtari patlatirdi -- ve daha kotusu, ayni
 * token'i iki ayri satir gibi gosterirdi. Kural tek yerde uygulanir ve semanin
 * CHECK'i onu SORGULANABILIR bir kural yapar: kucuk harfli olmayan bir deger
 * veritabanina hic giremez.
 */
export function lower(addr: Address | string): string {
  if (!ADDRESS.test(addr)) throw new RangeError(`lower: adres degil: ${addr}`)
  return addr.toLowerCase()
}

const HASH32 = /^0x[0-9a-fA-F]{64}$/

/** 0x + 64 hex; `tx_hash` ve `salt` sutunlarinin TypeScript tarafi. */
export function lowerHash32(value: string): string {
  if (!HASH32.test(value)) throw new RangeError(`lowerHash32: 32 baytlik hex degil: ${value}`)
  return value.toLowerCase()
}

// U+0000 ve TEK BASINA kalan vekil (surrogate) kod birimleri. `u` bayragi
// BILEREK yok: vekilleri kod BIRIMI olarak gorebilmek gerekiyor.
//
// `no-control-regex` KAPATILIYOR ve gerekcesi su: kural KAZARA girmis kontrol
// karakterlerini yakalamak icin var; burada kontrol karakteri tam olarak
// ARANAN seydir ve onu desenden cikarmak fonksiyonu islevsiz birakirdi.
/* eslint-disable no-control-regex */
const PG_TEXT_HOSTILE =
  /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/* eslint-enable no-control-regex */

/** Postgres'in `text`'ine giremeyen bir seyin yerine konan U+FFFD. */
const REPLACEMENT = '\uFFFD'

/**
 * `name`, `symbol` ve `uri` icin ZORUNLU temizleyici.
 *
 * OLCULDU (Postgres 17.9, gercek sunucu):
 *   insert into t values (chr(0));
 *   ERROR:  null character not permitted
 *   select convert_from('\xfffe'::bytea,'UTF8');
 *   ERROR:  invalid byte sequence for encoding "UTF8": 0xff
 *
 * Solidity `string`'i DOGRULANMAMIS bayttir; `LaunchFactory.launch` yalnizca
 * uzunluga bakar (bos degil) ve `LaunchToken`'in constructor'i yalnizca tavana
 * bakar -- ICERIGE hicbiri bakmaz. Yani icinde U+0000 tasiyan bir isim
 * tamamen zincir-mesru bir launch'tur ve Postgres'in `text` tipi onu KABUL
 * EDEMEZ. Temizlenmeden yazilmaya kalkilirsa ingest islemi geri alinir ve
 * indexer o blokta SONSUZA KADAR kilitlenir -- CHECK kisitlariyla
 * YAKALANAMAYAN bir liveness arizasi, cunku deger sunucuya hic ulasmaz.
 *
 * Semanin bunu kisitla zorlayacak bir yolu YOKTUR; bu yuzden kural yazicinin
 * tarafinda, semanin YANINDA durur ve `test/text.test.ts` onu gercek bir
 * sunucuya karsi calistirarak ispatlar.
 *
 * Uzunluk NOTU: temizleme karakter SAYISINI degistirmez (her dusman kod birimi
 * TEK bir U+FFFD olur), yani `length(name) <= 32` CHECK'i temizlemeden
 * etkilenmez.
 */
export function pgSafeText(value: string): string {
  return value.replace(PG_TEXT_HOSTILE, REPLACEMENT)
}

/**
 * UTF-8 baytlarinin `0x` onaltilik gosterimi -- `launches.{name,symbol,uri}_hex`
 * sutunlarinin TypeScript tarafi.
 *
 * NICIN VAR: `pgSafeText` COKA-BIR bir eslemedir. Zincirdeki AYRI iki isim,
 * `a<U+0000>b` ve `a<U+FFFD>b`, ayni gosterim metnine duser. Token adresi
 * CREATE2 ile HAM baytlardan turetildigi ve `LaunchFactory.isCanonical` tam
 * olarak o turetmeyi yeniden hesapladigi icin, yalnizca gosterim metnini
 * saklayan bir veritabani dusman metinli bir launch'un canonicity'sini BIR
 * DAHA dogrulayamaz. Ham baytlar ayri bir sutunda durur ve dogrulama
 * veritabanina bakarak yapilabilir kalir.
 *
 * DIKKAT -- BU FONKSIYON SON CARE: gecerli UTF-8 tasiyan bir dizge icin
 * zincirdeki baytlari TAM olarak yeniden uretir, ama zincirdeki bayt dizisi
 * GECERSIZ UTF-8 ise cozucu onu coktan U+FFFD yapmistir ve buradan geri
 * alinamaz. Tek dogru kaynak logun COZULMEMIS `data` alanidir; `LaunchEvent`
 * bu yuzden hex alanlarini ZORUNLU tutar ve turetmeyi cagirana birakir.
 */
export function toHexBytes(value: string): string {
  let out = '0x'
  for (const b of new TextEncoder().encode(value)) out += b.toString(16).padStart(2, '0')
  return out
}

/** `toHexBytes`'in tersi. Gecersiz UTF-8 baytlari U+FFFD olur (kayipli, bilerek). */
export function fromHexBytes(hex: string): string {
  if (!/^0x([0-9a-f]{2})*$/.test(hex)) throw new RangeError(`fromHexBytes: hex degil: ${hex}`)
  const body = hex.slice(2)
  const bytes = new Uint8Array(body.length / 2)
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return new TextDecoder().decode(bytes)
}
