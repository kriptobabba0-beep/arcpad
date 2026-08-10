/**
 * PROFIL KIMLIGI, TARAYICIDAN DA ERISILEBILIR OLACAK SEKILDE.
 *
 * `profiles.ts` `node:fs` ile `profiles.toml`u okur, yani tarayici girisinden
 * ERISILEMEZ. Ama profilin ADI -- `"testnet" | "production"` -- artik bir
 * istemci bileseninin ihtiyac duydugu bir seydir: al-sat panelindeki mutlak
 * para kisayollarinin merdiveni profile baglidir (bkz.
 * `web/components/token/tradeModel.ts`), cunku iki profil `V`de tam 1000 kat
 * ayrisir ve kotayla olculen HER buyukluk onunla birlikte ayrisir.
 *
 * BU DOSYA `CurveProfile`IN COZUMUNUN AYNISIDIR. O tip de ayni sebeple
 * `curve.ts`e tasinmisti ve `profiles.ts` onu yeniden disa aktariyor. Burada da
 * oyle: asagidakiler `profiles.ts` tarafindan yeniden disa aktarilir, yani
 * MEVCUT HER IMPORTER AYNEN CALISIR ve TEK bir tanim vardir, ikiz degil.
 * Ikinci bir union yazmak -- web tarafinda elle `'testnet' | 'production'` --
 * sessizce ayrisabilen bir kopya olurdu.
 *
 * Burada `viem` bile yok: yalnizca iki literal ve onlarin uzerindeki tip.
 */

/**
 * `keccak256(abi.encode(T, V, S))`, PROFIL BASINA, ELLE YAZILMIS.
 *
 * `contracts/script/Profiles.sol` icindeki `TESTNET_DIGEST` /
 * `PRODUCTION_DIGEST` ile AYNI literallerdir ve oyle olmalidir. Dosyadan
 * okunani hash'leyip buraya yazan bir uretim adimi TOTOLOJI olurdu: hash
 * her zaman kendisiyle esitlenirdi. Elle yazilmis olmalari sayesinde
 * `profiles.test.ts` GERCEK bir capraz-dil kapisidir -- Solidity ile
 * TypeScript "testnet"in ne demek oldugu konusunda ayrisirsa, bunu soyleyen
 * test odur.
 */
export const PROFILE_DIGESTS = {
  testnet: '0xa67f784bd45f49baa48601d390ecafdb2fe44aadffd974b4b0bd582c10d6600d',
  production: '0x7def5669fd9a5fd109bf35f1d1b04c651e124b6f0f22c37ced26fb77880a80e3',
} as const

export type ProfileName = keyof typeof PROFILE_DIGESTS

export const PROFILE_NAMES = Object.keys(PROFILE_DIGESTS) as ProfileName[]

export function isProfileName(name: string): name is ProfileName {
  return Object.prototype.hasOwnProperty.call(PROFILE_DIGESTS, name)
}
