.PHONY: install build test fmt fmt-check fork-test dev clean

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

fmt-check:
	forge fmt --check --root contracts

# Arc'a ozgu davranis yalnizca gercek RPC'de gozlemlenebilir; anvil bunu
# yeniden uretemez.
fork-test:
	forge test --root contracts --match-path 'test/fork/*' --fork-url $(ARC_RPC_URL) -vv

dev:
	pnpm --filter @arcpad/web dev

clean:
	forge clean --root contracts
	rm -rf node_modules packages/*/node_modules indexer/node_modules keeper/node_modules web/node_modules web/.next
