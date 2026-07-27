# arcpad

Circle'ın Arc L1'i üzerinde sabit arzlı token launchpad'i. Tüm arz bir bonding
curve'de satışa çıkar; curve tükendiğinde launch, likiditesi kalıcı olarak
kilitlenmiş bir Uniswap V4 havuzuna graduate olur. Karşı bacak Arc'ın native
para birimi olan USDC'dir.

> `arcpad` geçici bir kod adıdır.

## Düzen

| Dizin | İçerik |
|---|---|
| `contracts/` | Foundry çalışma alanı (solc 0.8.26, cancun, via_ir) |
| `indexer/` | Zinciri okuyup Postgres'e yazan TypeScript servisi |
| `keeper/` | Limit emir tetikleyici ve graduation itici |
| `web/` | Next.js arayüzü |
| `packages/shared/` | Zincir tanımı, USDC yardımcıları — tek kaynak |
| `docs/specs/` | Tasarım dokümanları |
| `docs/plans/` | Faz faz uygulama planları |

## Önkoşullar

| Araç | Neden | Kurulum |
|---|---|---|
| `git` | Submodule'ler dahil depoyu klonlamak için | [git-scm.com](https://git-scm.com/downloads) |
| `make` | Tüm komutlar `Makefile` üzerinden çalışır. **Windows'ta stok kurulumda yok** — winget ile kurulmalı: `winget install ezwinports.make` | [ezwinports.make](https://github.com/skeeto/w64devkit) veya paket yöneticiniz |
| Foundry `v1.6.0-rc1` | `forge`/`cast`/`anvil` — kontrat build/test zinciri. Sürüm CI ile aynı pinlenmiş sürümde olmalı (bkz. `CONTRIBUTING.md`) | `foundryup -v v1.6.0-rc1` (önce [foundryup](https://getfoundry.sh)) |
| Node `24` | pnpm workspace'i çalıştırır | [nodejs.org](https://nodejs.org) |
| pnpm `11.17.0` | TypeScript paket yöneticisi. Ayrı kurulum gerekmez — Node 24 ile gelen corepack `make install` içinde etkinleştirilir; corepack `EPERM` ile başarısız olursa elle kurun: `npm install -g pnpm@11.17.0` (detay: `CONTRIBUTING.md`) | corepack (varsayılan) |

## Başlangıç

```bash
make install
cp .env.example .env
make test
```

## Ağ

Arc testnet, chainId `5042002`. Native gas token USDC'dir: native görünüm 18
decimal, ERC-20 görünümü 6 decimal (`0x3600000000000000000000000000000000000000`).
**Bunlar aynı bakiyenin iki görünümüdür, iki ayrı varlık değil.**

Test USDC'si: https://faucet.circle.com

## Komutlar

| Komut | Ne yapar |
|---|---|
| `make install` | pnpm'i etkinleştirir, bağımlılıkları kurar, submodule'leri günceller |
| `make build` | Kontratları ve TypeScript paketlerini derler |
| `make test` | Birim testleri (fork testleri hariç) |
| `make fork-test` | Arc testnet fork'una karşı davranış testleri |
| `make fmt` | Solidity ve TypeScript'i formatlar |
| `make fmt-check` | Formatı değiştirmeden doğrular — **CI'ın çalıştırdığı komut budur** |
| `make lint` | TypeScript'i ESLint ile denetler (`en-US` locale kuralı dahil) |
| `make dev` | Web arayüzünü geliştirme modunda başlatır |
| `make clean` | Build çıktılarını ve `node_modules`'ü siler |
