.PHONY: install build test fixtures fmt fmt-check lint fork-test fork-test-live slither dev clean frozen-hash frozen-hash-chain deps-pin deps-pin-chain

install:
	corepack enable pnpm || pnpm --version
	pnpm install
	git submodule update --init --recursive

build:
	forge build --root contracts --sizes
	pnpm -r --if-present build

# `frozen-hash` ON KOSULDUR VE BU BILINCLI BIR SECIMDIR. `DeployLib`in
# broadcast oncesi kapisi `out-frozen/`den okur; o dizin `.gitignore`dadir,
# yani TAZE BIR KLONDA YOKTUR. Bagimliligi buraya koymanin alternatifi, taze
# klonda deploy paketinin CEVRESEL bir sebeple kirmizi olmasiydi -- ve bu depo
# iki kez ogrendi ki insanlarin gormezden gelmeye alistigi bir kapi, hic
# olmayan bir kapidan KOTUDUR (90 hatalik lint kosusu; kalici kirmizi haftalik
# prova).
#
# AYRIM SU: DERLEYICI kosmayi bilir, OPERATOR tahmin etmek zorunda kalmaz --
# ama BROADCAST yine de fail-closed'dir. `forge script --broadcast`,
# `make frozen-hash` kosmadan `FrozenArtifactMissing` ile DUSER ve bu KASITLIDIR:
# dondurulmus bytecode'u dogrulanmamis bir deploy yayin YAPAMAMALIDIR.
test: frozen-hash deps-pin
	forge test --root contracts --no-match-path 'test/fork/*' -vv
	pnpm -r test

# Faz 3 indexer fixture'lari. `make test` bu testi ZATEN kosar (FixtureGen
# `test/fork/*` disindadir), yani fixture'lar her kosuda yeniden uretilir; bu
# hedef yalnizca onlari TEK BASINA uretmenin kisa yoludur.
#
# Kapinin ikinci yarisi CI'dadir (.github/workflows/contracts.yml) ve `git
# diff`ten IBARET DEGILDIR: `git diff` IZLENMEYEN dosyalari GORMEZ (olculdu --
# fixture'lar henuz commit'lenmemisken, 5 dosyanin icerigini degistiren bir
# mutant altinda `git diff --exit-code` yine de 0 dondu). Bu yuzden CI ayrica
# `git status --porcelain` ile bos-olmayan bir calisma agacini reddeder.
fixtures:
	forge test --root contracts --match-contract FixtureGen

# DONDURULMUS BYTECODE KAPISI. `forge inspect ... | sha256sum`IN YERINE GECER
# VE SEBEBI OLCULDU: o komut `out/` icindeki artifact'i okur, o artifact'i IKI
# ayri derleme isi yazar (`optimizer_runs` 800 ve 44444444) ve hangisinin
# kazandigi CAGRI SIRASINA baglidir -- ayni agacta, arada hicbir kaynak
# degisikligi olmadan, ilk cagri `8e2460ff...` ve sonraki her cagri
# `e73842c9...` dondu. Kapi bunun yerine `[profile.frozen]`i KENDISI derler ve
# YALNIZCA o profilin yazabildigi `out-frozen/`den okur.
#
# `PYTHON` secimi ayristirma aninda yapilir; `python3 || python` seklinde bir
# yedekleme YANLIS olurdu, cunku gercek bir KIRMIZI KAPININ cikis kodunu
# "yorumlayici yok" durumundan ayirt edemez -- `slither` hedefindeki ayni
# gerekce.
PYTHON := $(shell command -v python3 >/dev/null 2>&1 && echo python3 || echo python)

frozen-hash:
	$(PYTHON) contracts/tools/frozen_bytecode_gate.py

# Ayni kapi + CANLI ZINCIR. Pin ile kapinin anlasmasi bir dosyadaki sayidir;
# gercek basari kosulu zincirin de ayni seyi soylemesidir.
frozen-hash-chain:
	$(PYTHON) contracts/tools/frozen_bytecode_gate.py --chain

# BAGIMLILIK SABITLEME KAPISI, VE ACIGIN NEREDE OLDUGU OLCULDU.
#
# Bir submodule kaymasinin BUYUK kismi zaten yakalanir, cunku baskasinin
# kaynagi bizim initcode'umuza GOMULUR ve o initcode'lar sabitlenmistir:
#   OZ ERC20      -> `LaunchToken` + `LaunchFactory` FROZEN hash'i kirmizi
#   uniswap-hooks -> `ARC_HOOK_CREATION_CODE_HASH` iddiasi kirmizi
#   v4-periphery  -> locker initcode'u degisir, `ARC_LOCKER` adres iddiasi
#                    kirmizi (locker CREATE2 ile, `predict(LOCKER_SALT, ...)`)
#
# YAKALANMAYAN TEK SEY VE EN ONEMLISI ODUR: `PoolManager`. O, kodu bizim
# hicbir initcode'umuza GIRMEYEN tek bagimliliktir -- ayri, coktan deploy
# EDILMIS bir kontrat ve biz yalnizca CAGIRIYORUZ. Testler onu submodule
# KAYNAGINDAN kurar. Yani v4-core kayarsa butun paket sessizce BASKA bir
# PoolManager'a karsi yesil kalir, canli zincirdeki ESKISI yerinde durur ve
# testler artik deploy EDILMEMIS bir kontratin ozelliklerini kanitliyor olur.
# Mezuniyet sonrasi butun likidite o kontratta durdugu icin bu kapi oradadir.
deps-pin:
	$(PYTHON) contracts/tools/dependency_pin_gate.py

# Ayni kapi + CANLI ZINCIR, ve iddiasi sudur: Arc'taki `PoolManager` ile
# ETHEREUM MAINNET'teki kanonik Uniswap v4 `PoolManager`i AYNI BAYTLARDIR.
# Olculdu: 24.009 baytin tamami esit, tek fark 13618. bayttaki 20 bayt ve o
# 20 bayt her kontratin KENDI adresi (`noDelegateCall` immutable'i).
#
# CI'DA KOSMAZ. Disaridaki bir kamu RPC'sini zorunlu kapiya cevirmek, kapiyi
# ag hatasiyla kirmizi yapardi -- ve bu depo iki kez ogrendi ki insanlarin
# gormezden gelmeye alistigi bir kapi, hic olmayan bir kapidan KOTUDUR.
deps-pin-chain:
	$(PYTHON) contracts/tools/dependency_pin_gate.py --mainnet

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
#
# ALT KATMAN B BURADAN DISLANIR VE AYRIM SADECE YOLLA YAPILAMAZ. Iki filtre
# birbirinin TUMLEYENIDIR: paket `--no-match-path 'test/fork/*'`, kapi
# `--match-path 'test/fork/*'`. Bir dosya ikisinden BIRINE mutlaka duser,
# dolayisiyla "B'yi baska bir dizine koy" tek basina B'yi FORK'SUZ PAKETE
# tasirdi -- ve orada fork olmadan kirmizi olurdu. Ayrim bu yuzden IKI
# EKSENLIDIR: dosya `test/fork/` altinda durur (paket dislar), kontrat adi
# `...LiveForkTest`tir ve bu hedef onu KONTRAT ADIYLA dislar (kapi dislar).
# Ayni `--no-match-contract` .github/workflows/contracts.yml'deki fork isinde
# de vardir; ikisi ayrisirsa CI B'yi ceker.
fork-test:
	forge test --root contracts --match-path 'test/fork/*' --no-match-contract 'LiveForkTest' \
	  --fork-url arc_testnet -vv

# ALT KATMAN B -- ELLE TETIKLENIR, CI'DA ASLA KOSMAZ.
#
# NICIN AYRI: B tam graduation dongusunu yurutur -- GECICI bir factory, GECICI
# bir hook (her kosuda yeniden madenlenir) ve GECICI bir locker uzerinde, ama
# CANLI `PoolManager`, `FeeEscrow`, `FeeSchedule` ve CANLI USDC kontratina
# karsi. Uretim fabrikasina HIC dokunmaz ve dokunmamalidir: `graduationTarget`
# silahlandiginda ilk graduation havuzu acar ve HOOK ADRESINI KALICI OLARAK
# DONDURUR.
fork-test-live:
	forge test --root contracts --match-contract 'LiveForkTest' --fork-url arc_testnet -vv

# `pip install slither-analyzer` konsol betigini her ortamda PATH'e koymaz --
# Windows'ta koymadigi olculdu ve `make slither` ciplak `slither` ile exit 127
# veriyordu. `python -m slither` her iki durumda da calisir. Secimi ayristirma
# aninda yapiyoruz; `slither || python -m slither` seklinde bir yedekleme YANLIS
# olurdu, cunku gercek bir HIGH/MEDIUM bulgusunun sifir-disi cikis kodunu
# "ikili yok" durumundan ayirt edemez ve taramayi bosuna iki kez calistirirdi.
SLITHER := $(shell command -v slither >/dev/null 2>&1 && echo slither || echo python -m slither)

slither:
	cd contracts && $(SLITHER) . --config-file slither.config.json --fail-medium

dev:
	pnpm --filter @arcpad/web dev

clean:
	forge clean --root contracts
	rm -rf node_modules packages/*/node_modules indexer/node_modules keeper/node_modules web/node_modules web/.next
