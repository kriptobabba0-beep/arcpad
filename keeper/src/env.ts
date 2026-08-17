import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

/**
 * `.env` DEPO KOKUNDEN OKUNUR, CALISMA DIZININDEN DEGIL.
 *
 * OLCULDU, VE BELGELENMIS BASLATMA KOMUTUNU OLDURUYORDU. Iki giris noktasi da
 * `import 'dotenv/config'` kullaniyordu; o modul dosyayi
 * `path.resolve(process.cwd(), '.env')` ile arar. `pnpm --filter <paket> ...`
 * ise komutu PAKET DIZININDE calistirir, yani calisma dizini
 * `<repo>/keeper`tir ve orada `.env` YOKTUR. Depo kokundeki `.env` hic
 * okunmaz.
 *
 * Sonuc, runbook'un section 8'de yazdigi komutun -- kelimesi kelimesine --
 * ciktisidir:
 *
 *     $ pnpm --filter @arcpad/keeper start
 *     Error: ARC_RPC_URL is not set (see .env.example)
 *
 * Yani "factory hicbir an izlenmeden canli olmasin" diye yazilmis izleyici,
 * belgelenmis tek baslatma komutuyla HIC BASLAMIYORDU. Bu, gurultulu bir
 * ariza oldugu icin sansliyiz; sessiz olsaydi kimse fark etmezdi.
 *
 * Cozum, bu dosyadaki diger iki yol sabitinin (`DEFAULT_CURSOR_PATH`,
 * `DEFAULT_GOVERNANCE_PATH`) ZATEN kullandigi kuraldir: yolu `import.meta.url`
 * uzerinden coz, `process.cwd()` uzerinden DEGIL. Boylece keeper nereden
 * baslatilirsa baslatilsin AYNI dosyayi okur.
 *
 * DISARIDAN VERILEN ENV KAZANIR. `override` varsayilan olarak kapalidir, yani
 * `KEEPER_ALERT_LOG=... pnpm --filter @arcpad/keeper start` ve CI'nin
 * enjekte ettigi degiskenler `.env`i EZER, tersi degil.
 *
 * `quiet: true`: dotenv 17 aksi halde stdout'a bir ozet satiri basar. Bu
 * surecin stdout'u ALARM LAVABOSUDUR (`OK ` / `HEARTBEAT ` satirlari) ve
 * tatbikat onu satir onekine gore ayristirir; oraya baska bir sey yazmak
 * alarm yolunun icine gurultu koymaktir.
 */
export const REPO_ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url))

export type RepoEnvLoad = { path: string; loaded: boolean }

/**
 * `.env` YOKSA HATA DEGILDIR ve olmamalidir: uretimde ve CI'da degiskenler
 * surece dogrudan enjekte edilir, dosya hic bulunmaz. Eksik bir degiskeni
 * ALANI ADIYLA reddetmek `loadKeeperConfig`/`loadWatcherConfig`in isidir; bu
 * fonksiyonun isi yalnizca DOGRU dosyaya bakmaktir.
 */
export function loadRepoEnv(target: NodeJS.ProcessEnv = process.env): RepoEnvLoad {
  const result = loadDotenv({ path: REPO_ENV_PATH, processEnv: target, quiet: true })
  return { path: REPO_ENV_PATH, loaded: result.error === undefined }
}
