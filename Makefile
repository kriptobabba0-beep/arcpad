.PHONY: install build test fmt fmt-check lint fork-test dev clean

install:
	corepack enable pnpm || pnpm --version
	pnpm install
	git submodule update --init --recursive

build:
	forge build --root contracts --sizes
	pnpm -r --if-present build

test:
	forge test --root contracts --no-match-path 'test/fork/*' -vv
	pnpm -r test

fmt:
	forge fmt --root contracts
	pnpm run fmt

fmt-check:
	forge fmt --check --root contracts
	pnpm run fmt:check

lint:
	pnpm run lint

# Arc'a ozgu davranis yalnizca gercek RPC'de gozlemlenebilir; anvil bunu
# yeniden uretemez. `arc_testnet`, contracts/foundry.toml [rpc_endpoints]
# icindeki takma addir ($ARC_RPC_URL'e cozulur). make bu degiskeni YUKLEMEZ
# (make .env'i okumaz) -- ama forge, calisma dizini olarak make'in kendi
# CWD'sini (bu Makefile'in bulundugu depo koku) kullanir ve ARC_RPC_URL'i
# oradaki .env dosyasindan dogrudan kendisi okur. Bu yuzden takma ad, make'in
# ortamina hic ihtiyac duymadan calisir; `cp .env.example .env` yeterlidir.
fork-test:
	forge test --root contracts --match-path 'test/fork/*' --fork-url arc_testnet -vv

dev:
	pnpm --filter @arcpad/web dev

clean:
	forge clean --root contracts
	rm -rf node_modules packages/*/node_modules indexer/node_modules keeper/node_modules web/node_modules web/.next
