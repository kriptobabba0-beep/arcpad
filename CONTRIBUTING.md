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

## Test katmanları

| Katman | Komut | Nerede koşar |
|---|---|---|
| Birim / fuzz / invariant | `make test` | Standart EVM |
| Fork | `make fork-test` | Gerçek Arc testnet |

`anvil` Arc'ı simüle **edemez** — native USDC davranışı, EIP-7708 `Transfer`
logları ve blocklist yalnızca gerçek RPC'de görünür. Arc'a özgü her iddia bir
fork testiyle desteklenmelidir.

## Commit

Her görev kendi commit'iyle biter. Commit mesajları neden'i anlatır, ne'yi değil.
