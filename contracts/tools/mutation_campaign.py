#!/usr/bin/env python3
"""
============================================================================
 HEDEFLI MUTASYON KAMPANYASI
============================================================================

"Testler geciyor" ile "testler bir sey olcuyor" ayni sey degildir. Bu betik
farki OLCER: denetimde TASIYICI oldugunu iddia ettigim her satiri bilerek
kirar ve bir testin oldugunu dogrular.

JENERIK BIR MUTASYON ARACI DEGIL, VE SEBEBI SINYAL. Bir arac yuzlerce
anlamsiz mutant uretir (bir loga dokunmak, ulasilamaz bir dal); burada
uretilen her mutant, raporun BIR IDDIASINA karsilik gelir. Hayatta kalan bir
mutant, o iddianin testsiz oldugu anlamina gelir -- yani raporun o satiri bir
olcum degil bir umut.

HER MUTANT GERI ALINIR. Kaynak `git checkout` ile geri yuklenir; betik
yarida kesilse bile agac kirli kalmaz (`finally`).
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts"


@dataclass(frozen=True)
class Mutant:
    """Bir iddia, onu kiran degisiklik, ve olmesi beklenen test kumesi."""

    name: str
    claim: str
    path: str
    find: str
    replace: str
    tests: str


MUTANTS: list[Mutant] = [
    # ---- CurveMath: yuvarlama yonleri ----------------------------------
    Mutant(
        name="quoteBuyCost drops the +1",
        claim="Alim maliyeti tavana yuvarlanir; +1 graduation fiyatinin YONUNU tasir",
        path="src/libraries/CurveMath.sol",
        find="return FullMath.mulDiv(tokensOut, quoteReserve, tokenReserve - tokensOut) + 1;",
        replace="return FullMath.mulDiv(tokensOut, quoteReserve, tokenReserve - tokensOut);",
        tests="CurveMath|BondingCurve|ArcpadLocker|GraduationMath",
    ),
    Mutant(
        name="feeOn rounds DOWN",
        claim="Ucret tavana yuvarlanir -- asagi yuvarlamak protokolun aleyhinedir",
        path="src/libraries/CurveMath.sol",
        find="return FullMath.mulDivRoundingUp(amount, feeBps, BPS_DENOMINATOR);",
        replace="return FullMath.mulDiv(amount, feeBps, BPS_DENOMINATOR);",
        tests="CurveMath|BondingCurve",
    ),
    Mutant(
        name="quoteSellProceeds rounds UP",
        claim="Satis hasilati tabana yuvarlanir -- yukari yuvarlamak curve'u sizdirir",
        path="src/libraries/CurveMath.sol",
        find="return FullMath.mulDiv(tokensIn, quoteReserve, tokenReserve + tokensIn);",
        replace="return FullMath.mulDivRoundingUp(tokensIn, quoteReserve, tokenReserve + tokensIn);",
        tests="CurveMath|BondingCurve",
    ),
    Mutant(
        name="correctedNetQuoteIn skips the overshoot correction",
        claim="Iki tavan yuvarlamasinin toplami butceyi asabilir; duzeltme onu kisar",
        path="src/libraries/CurveMath.sol",
        find="""        uint256 overshoot = total - grossQuoteIn;
            if (overshoot >= net) revert NetTooSmall();
            net -= overshoot;""",
        replace="""        uint256 overshoot = total - grossQuoteIn;
            if (overshoot >= net) revert NetTooSmall();""",
        tests="CurveMath|BondingCurve",
    ),
    # ---- BondingCurve: para korumalari ---------------------------------
    Mutant(
        name="buyExactTokensOut stops checking msg.value",
        claim="Toplam maliyet msg.value'yu ASAMAZ -- yoksa odenmeden token alinir",
        path="src/BondingCurve.sol",
        find="if (total > maxQuoteIn || total > msg.value) revert SlippageExceeded();",
        replace="if (total > maxQuoteIn) revert SlippageExceeded();",
        tests="BondingCurve|invariant",
    ),
    Mutant(
        name="sell drops the proceeds>fees guard",
        claim="Hasilat ucretleri karsilamiyorsa REDDEDILIR; yoksa cikarma altta tasar",
        path="src/BondingCurve.sol",
        find="if (proceeds <= protocolFee + creatorFee) revert ProceedsTooSmall();",
        replace="if (proceeds < protocolFee + creatorFee) revert ProceedsTooSmall();",
        tests="BondingCurve",
    ),
    Mutant(
        name="graduate() sets the flag AFTER the payouts",
        claim="Bayrak odemeden ONCE yazilir -- pump.fun'in Solana sirasi burada yeniden girisi acar",
        path="src/BondingCurve.sol",
        find="""        graduated = true;

        // --- 3. OLAY ---
        emit Graduated(token, target, baseAmount, quoteAmount);

        // --- 4. DIS CAGRILAR ---
        if (!IERC20(token).transfer(target, baseAmount)) revert TokenTransferFailed();
        (bool ok,) = target.call{value: quoteAmount}("");
        if (!ok) revert GraduationPayoutFailed();""",
        replace="""        emit Graduated(token, target, baseAmount, quoteAmount);

        if (!IERC20(token).transfer(target, baseAmount)) revert TokenTransferFailed();
        (bool ok,) = target.call{value: quoteAmount}("");
        if (!ok) revert GraduationPayoutFailed();
        graduated = true;""",
        tests="BondingCurve|ArcpadLocker|invariant",
    ),
    Mutant(
        name="_settleBuy writes the ledger AFTER the external calls",
        claim="KATI CEI: her defter yazimi her dis cagridan once biter",
        path="src/BondingCurve.sol",
        find="""        bool justCompleted = realTokenReserves == 0;
        if (justCompleted) complete = true;""",
        replace="""        bool justCompleted = realTokenReserves == 0;""",
        tests="BondingCurve|invariant",
    ),
    Mutant(
        name="bind stops checking the token balance",
        claim="S + D bakiyesi dogrulanir; yoksa graduation YAPISAL olarak fonlanamaz",
        path="src/BondingCurve.sol",
        find="""        if (IERC20(token_).balanceOf(address(this)) < INITIAL_REAL_TOKEN_RESERVES + poolSeedSupply) {
            revert TokenBalanceBelowSaleAndSeed();
        }""",
        replace="",
        tests="BondingCurve|LaunchFactory",
    ),
    Mutant(
        name="bind stops checking the token points back",
        claim="Token curve'u geri isaret etmeli; yoksa curve bos bir arza baglanir",
        path="src/BondingCurve.sol",
        find="if (ICurveBoundToken(token_).curve() != address(this)) revert TokenDoesNotPointBack();",
        replace="",
        tests="BondingCurve|LaunchFactory",
    ),
    # ---- Denetimin KENDI duzeltmeleri ----------------------------------
    Mutant(
        name="locker drops the curve/token binding (THE audit finding)",
        claim="A-01: sahte bir curve kanonik havuzu odeme yapilmadan acardi",
        path="src/ArcpadLocker.sol",
        find="if (ILaunchTokenCurve(token).curve() != curve) revert CurveTokenMismatch();",
        replace="",
        tests="ArcpadLocker",
    ),
    Mutant(
        name="hook drops the graduated() check (audit layer two)",
        claim="A-01 ikinci katmani: hedef yeniden yanlis yazilsa bile havuz odemesiz acilamaz",
        path="src/ArcpadHook.sol",
        find="if (!ICurveView(curve).graduated()) revert CurveNotGraduated();",
        replace="",
        tests="ArcpadLocker|ArcpadHook",
    ),
    Mutant(
        name="hook accepts a zero escrow",
        claim="A-04: kodsuz escrow'a deposit REVERT ETMEZ -- ucret sessizce yanar",
        path="src/ArcpadHook.sol",
        find="if (escrow_ == address(0)) revert ZeroDependency();",
        replace="",
        # "ArcpadLocker" filtresi bu testi TUTMUYOR -- kontrat adi
        # "ArcpadPoolLayerZeroDependencyTest". Ilk kosuda mutant bu yuzden
        # HAYATTA KALDI, ve bu bir bosluk degil bir FILTRE hatasiydi. Yanlis
        # filtreyle "iddia testsiz" diye rapor etmek, denetimin kendi
        # sinamasindan gecmemesi olurdu.
        tests="ArcpadPoolLayerZeroDependency",
    ),
    # ---- Hook: ucret muhasebesi ----------------------------------------
    Mutant(
        name="hook takes the fee but deposits a smaller one",
        claim="take ile deposit TAM dengelenir; fark hook'ta kalir",
        path="src/ArcpadHook.sol",
        find="quote.take(poolManager, address(this), fee, false);",
        replace="quote.take(poolManager, address(this), fee + 1, false);",
        tests="ArcpadHook|ArcpadLocker",
    ),
    # ---- FeeEscrow ------------------------------------------------------
    Mutant(
        name="escrow claims before zeroing the debt",
        claim="CEI: once defter, sonra transfer -- yoksa yeniden giris bosaltir",
        path="src/FeeEscrow.sol",
        find="""        owed[recipient] = 0;
        totalOwed -= amount;

        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();""",
        replace="""        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();

        owed[recipient] = 0;
        totalOwed -= amount;""",
        tests="FeeEscrow|invariant",
    ),
    # ---- LaunchFactory --------------------------------------------------
    Mutant(
        name="factory drops the governor check on propose",
        claim="Mezuniyet hedefini YALNIZCA governor onerebilir",
        path="src/LaunchFactory.sol",
        find="""    function proposeGraduationTarget(address target_) external {
        if (msg.sender != governor) revert NotGovernor();""",
        replace="""    function proposeGraduationTarget(address target_) external {""",
        tests="LaunchFactory",
    ),
    Mutant(
        name="factory drops the proposal expiry",
        claim="Suresi gecmis bir oneri SONSUZA KADAR silahli kalmaz",
        path="src/LaunchFactory.sol",
        find="if (block.timestamp > eta + GRADUATION_TARGET_DELAY) revert GraduationTargetProposalExpired();",
        replace="",
        tests="LaunchFactory",
    ),
    Mutant(
        name="factory lets the treasury be the escrow",
        claim="treasury == escrow yapistirma hatasi ucreti KALICI olarak talep edilemez yapar",
        path="src/LaunchFactory.sol",
        find="""        if (protocolTreasury_ == address(0)) revert ZeroTreasuryAddress();
        if (protocolTreasury_ == escrow) revert TreasuryIsTheEscrow();""",
        replace="""        if (protocolTreasury_ == address(0)) revert ZeroTreasuryAddress();""",
        tests="LaunchFactory",
    ),
    # ---- Router ---------------------------------------------------------
    Mutant(
        name="router takes the payer from the caller",
        claim="payer HER ZAMAN msg.sender; parametre olsaydi butun onaylar herkese acilirdi",
        path="src/ArcpadRouter.sol",
        find="""        int256 specified = c.amountSpecified < 0 ? -int256(amountIn) : int256(amountOut);
        if (specified != c.amountSpecified) revert PartialFill(c.amountSpecified, specified);""",
        replace="",
        tests="ArcpadRouter",
    ),
    Mutant(
        name="router drops the int128 ceiling",
        claim="Ust sinir sessiz bir ISARET degisimini onler: exact-in sessizce exact-out olur",
        path="src/ArcpadRouter.sol",
        find="if (amount == 0 || amount > uint256(uint128(type(int128).max))) revert AmountOutOfRange(amount);",
        replace="if (amount == 0) revert AmountOutOfRange(amount);",
        tests="ArcpadRouter",
    ),
]


def run(cmd: list[str], cwd: Path) -> tuple[int, str]:
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def restore(paths: set[str]) -> None:
    for rel in sorted(paths):
        run(["git", "checkout", "--", f"contracts/{rel}"], ROOT)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None, help="ada gore suz")
    args = ap.parse_args()

    selected = [m for m in MUTANTS if args.only is None or args.only.lower() in m.name.lower()]
    touched: set[str] = set()
    results: list[tuple[Mutant, str, str]] = []

    print(f"{len(selected)} mutant\n")
    try:
        for i, m in enumerate(selected, 1):
            src = CONTRACTS / m.path
            original = src.read_text(encoding="utf-8")
            # BOSLUGA DAYANMAZ: kaynak yeniden bicimlendirilse de bulur.
            needle = m.find.strip()
            squashed = " ".join(needle.split())
            hit = needle in original
            if not hit:
                # Bosluklari normalize ederek ikinci bir deneme.
                flat = " ".join(original.split())
                hit = squashed in flat
            if not hit:
                results.append((m, "BULUNAMADI", "desen kaynakta yok -- mutant gecersiz"))
                print(f"[{i}/{len(selected)}] {m.name}: DESEN BULUNAMADI")
                continue

            src.write_text(original.replace(needle, m.replace.strip()), encoding="utf-8")
            touched.add(m.path)

            code, out = run(
                ["forge", "test", "--match-contract", m.tests, "--no-match-path", "test/fork/*"],
                CONTRACTS,
            )
            src.write_text(original, encoding="utf-8")

            if code != 0:
                # Derleme hatasi da bir olumdur AMA ayri raporlanir: testin
                # degil derleyicinin yakaladigi anlamina gelir.
                kind = "OLDU (derleme)" if "Compiler run failed" in out or "Error (" in out else "OLDU"
                detail = ""
                for line in out.splitlines():
                    if line.startswith("[FAIL"):
                        detail = line.strip()[:100]
                        break
                results.append((m, kind, detail))
            else:
                results.append((m, "HAYATTA", "hicbir test olmedi -- iddia TESTSIZ"))
            print(f"[{i}/{len(selected)}] {m.name}: {results[-1][1]}")
    finally:
        restore(touched)

    print("\n" + "=" * 78)
    survivors = [r for r in results if r[1] == "HAYATTA"]
    missing = [r for r in results if r[1] == "BULUNAMADI"]
    print(f"olen {len(results) - len(survivors) - len(missing)}/{len(results)}, "
          f"hayatta {len(survivors)}, gecersiz {len(missing)}")
    for m, verdict, detail in results:
        if verdict != "OLDU":
            print(f"  {verdict:16} {m.name}\n{' ' * 20}iddia: {m.claim}\n{' ' * 20}{detail}")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
