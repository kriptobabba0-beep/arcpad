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
| `make build` | Kontratları ve TypeScript paketlerini derler |
| `make test` | Birim testleri (fork testleri hariç) |
| `make fork-test` | Arc testnet fork'una karşı davranış testleri |
| `make fmt` | Solidity formatlar |
| `make dev` | Web arayüzünü geliştirme modunda başlatır |
