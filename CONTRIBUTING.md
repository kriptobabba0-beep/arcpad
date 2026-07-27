# Katkı rehberi

## Kırılmaz kurallar

- **`C:\Users\iTopya\Desktop\arc-proje` (Limen Finance) salt-okunurdur.** Oradan
  desen kopyalanır, oraya hiçbir şey yazılmaz.
- **Özel anahtarlar asla argv'de veya `.env`'de taşınmaz.** Şifreli keystore
  kullanılır: `cast wallet import arcpad-deployer --interactive`
- **`forge install` kullanılmaz.** Depo kökü git deposu olduğu için bağımlılıklar
  yanlış yere kurulur ve komut `prefix not found` ile kırılır. Bunun yerine:
  `git submodule add --depth 1 <url> contracts/lib/<ad>`
- **Tüm forge komutları `--root contracts` alır.**
- **Native USDC (18 decimal) ile ERC-20 USDC (6 decimal) aynı varlıktır.**
  Asla toplanmaz, asla birbirine çevrilerek "swap" edilmez.
- **Sayı biçimlendirmede locale her zaman `en-US` olarak verilir.**
- **TypeScript import'ları uzantısızdır** (`./chain`, `../src/usdc`).

## Kurulum

`make install` ilk adımda `corepack enable pnpm` çalıştırır. Bazı makinelerde
(ör. Node kurulum dizini üzerinde yazma izni olmadığında) bu adım `EPERM` ile
başarısız olur; `make install` bu durumda pnpm zaten kuruluysa devam eder.
Global pnpm kurulu değilse elle kurun: `npm install -g pnpm@11.17.0`.

## Build yapılandırması

`solc 0.8.26`, `evm_version = "cancun"`, `via_ir = true`. Üçü de Uniswap V4'ün
gereğidir ve v4-core'un kendi yapılandırmasıyla aynıdır. Değiştirme.

**Foundry sürümü:** `v1.6.0-rc1` (`forge --version` çıktısındaki
`Commit SHA: b272ce3366987406406e9eb1b82596653a3ad628`). CI bu sürüme
`.github/workflows/contracts.yml` içinde `foundry-toolchain@v1`'in `version:`
girdisiyle pinlidir — pinlenmezse CI en güncel Foundry'yi çeker ve
`forge fmt` çıktısı sürüme duyarlı olduğu için kod değişmeden formatting
kapısı kırılabilir.

## Submodule takibi

`forge-std` (`v1.16.2`) ve `uniswap-hooks` (`v1.2.1`) en son kararlı sürüm
tag'ine pinlidir. `v4-core` ve `v4-periphery` ise **branch tip**'te (main)
kalır, geçici değil kalıcı bir karardır:

- **`v4-periphery`**: depoda hiç release tag'i yok (`git ls-remote --tags`
  boş döner). Pinlenecek bir sürüm yok.
- **`v4-core`**: tüm tarihinde tek tag var, `v4.0.0` (Ocak 2025). Bu tag
  `uniswap-hooks@v1.2.1` ile derlenmiyor —
  `Source "@uniswap/v4-core/src/types/PoolOperation.sol" not found` hatası
  veriyor; bu dosya yalnızca `v4.0.0`'dan sonraki main commit'lerinde
  eklenmiş. `v4-periphery` zaten main tip'te kalmak zorunda olduğu için
  `v4-core`'u tek (ve eski) tag'ine pinlemek onu `v4-periphery` ve
  `uniswap-hooks` ile uyumsuz bırakırdı; bu yüzden `v4-core` da main tip'te
  kalıyor.

Bu iki bağımlılık post-audit, unreleased kod taşıyor. Faz 2 başlamadan önce
yeniden değerlendirilmeli: Uniswap yeni bir tag keserse o tag'e geçilmeli.

## Test katmanları

| Katman | Komut | Nerede koşar |
|---|---|---|
| Birim / fuzz / invariant | `make test` | Standart EVM |
| Fork | `make fork-test` | Gerçek Arc testnet |

`anvil` Arc'ı simüle **edemez** — native USDC davranışı, EIP-7708 `Transfer`
logları ve blocklist yalnızca gerçek RPC'de görünür. Arc'a özgü her iddia bir
fork testiyle desteklenmelidir.

## Statik analiz

**Kurulum:** Slither kurulu değilse `pip install slither-analyzer` ile
kurulur. Kurulumdan sonra `slither` komutu **PATH'e otomatik düşmeyebilir** —
pip'in script'leri koyduğu dizin (bu makinede
`C:\Users\iTopya\AppData\Local\Programs\Python\Python311\Scripts`) shell
PATH'inde değilse `slither: command not found` alınır; tam olarak bu
depoda yaşandı. Çözüm o dizini oturum için PATH'e eklemektir (örn.
`export PATH="$PATH:/c/Users/iTopya/AppData/Local/Programs/Python/Python311/Scripts"`
Git Bash'te). CI bundan etkilenmez: taze bir `ubuntu-latest` runner'ında
`pip install slither-analyzer` sonrası `slither` PATH'e normal şekilde düşer.

`make slither`, `contracts/` içinden `slither . --config-file slither.config.json
--fail-medium` çalıştırır — CI'daki `.github/workflows/slither.yml` da
birebir aynı komutu çağırır, yerelde geçen bir çalıştırma CI'da da geçer.
(Not: `slither-analyzer`'ın güncel CLI'ında eşik bayrağı `--fail-on <seviye>`
değil `--fail-medium`/`--fail-high`/... biçimindedir; varsayılan
`--fail-pedantic`'tir ve bayrak verilmezse LOW/INFO bulgular bile kapıyı
kırar.)
Slither, Foundry projesini `contracts/` içinden algılayıp `remappings.txt`'yi
kendisi okur; kapı yalnızca `contracts/src/**` altındaki birinci taraf koda
bakar (`contracts/slither.config.json`'daki `filter_paths`, `lib/`, `test/`
ve `script/`'i eler).

**Tuzak — `filter_paths` MUTLAK yola karşı eşleşir:** `filter_paths`
(`lib/|test/|script/`) çapasız bir regex/alt-dize eşleşmesidir ve
crytic-compile'ın kaydettiği yol üzerinde çalışır — bu yol bazen mutlak
yoldur. Bugün bu depoda sorun çıkarmıyor çünkü `D:\pumpfunforarc\contracts\...`
içinde `lib/`, `test/` veya `script/` alt dizesi geçmiyor. Ama depo bu alt
dizelerden birini içeren bir dizine checkout edilirse — bir CI workspace'i,
bir fork dizini, `test` geçen bir branch adıyla adlandırılmış checkout
dizini — kapı **hatasız ve sessizce** az-analiz eder: tüm proje filtrelenir,
`0 result(s) found` basılır ve bu, gerçekten temiz bir çalıştırmadan
**ayırt edilemez** görünür. Bu tam olarak bir gözden geçirenin başına geldi:
scratch dizini `slither-dirty-test` adlıydı, `test/` alt dizesi mutlak yolu
eşleştirdi ve tüm proje sessizce filtrelendi. Şüpheli derecede az bulgu
görülürse ilk kontrol edilecek şey checkout yolunun bu alt dizelerden birini
içerip içermediğidir.

Ayrıca CI'daki `pip install slither-analyzer` **sürüme pinlenmemiştir**:
gelecekteki bir sürüm detektör davranışını veya CLI bayraklarını
değiştirebilir — nitekim bu göreve tam olarak bu oldu (brief'teki
`--fail-on medium` bayrağı hiçbir yayınlanmış sürümde mevcut değildi; gerçek
bayrak `--fail-medium`). Slither bir gün beklenmedik şekilde farklı
davranırsa önce kurulu sürümü kontrol edin.

HIGH veya MEDIUM önem düzeyindeki bir bulgu, `docs/audit/slither-triage.json`
içindeki `accepted` listesinde yazılı bir gerekçeyle yer almıyorsa kapıyı
kırar. Bir girişin kabul edilmesi için "Slither yanılıyor" yeterli değildir —
bulgunun bu koda neden uygulanmadığını bir gözden geçireni ikna edecek şekilde
açıklamak gerekir. Gerçek bir bulgu ise (koda dokunmadan giderilemiyorsa) kod
düzeltilir, susturulmaz.

LOW ve INFORMATIONAL bulgular her çalıştırmada raporlanır ama kapıyı kırmaz;
susturulmazlar, sadece engellemezler.

## Commit

Her görev kendi commit'iyle biter. Commit mesajları neden'i anlatır, ne'yi değil.
