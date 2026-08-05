"""Chain truth, run 3: the four headline numbers + the holder-count PROOF,
derived from raw JSON-RPC with no shared code with the layers under test.

One batched `eth_call` request, retried with a slow ladder, because the indexer
and the keeper are on the same endpoint.
"""
import json, sys, time, urllib.request

RPC = "https://rpc.testnet.arc.network"
TOKEN = "0x1bd93613a7bc470a739d9615cdc65e535d958fab"
CURVE = "0x7938be340a14a12f94a83aea246d9d2566324c9c"
DEPLOYER = "0xe92c64c4f36216ea773f2622f6d5f8530ae92fd2"

SEL = {
    "virtualTokenReserves": "0x50f4c37e",
    "virtualQuoteReserves": "0x0b26cf66",
    "realTokenReserves": "0x8e6650f5",
    "realQuoteReserves": "0x63b93a5a",
    "complete": "0x", # filled below
}


def rpc(payload, tries=8):
    for a in range(tries):
        req = urllib.request.Request(
            RPC,
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json", "user-agent": "arcpad-integration/1"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                res = json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            print(f"  http retry {a}: {e}", file=sys.stderr)
            time.sleep(3 * (a + 1))
            continue
        items = res if isinstance(res, list) else [res]
        errs = [i for i in items if "error" in i]
        if not errs:
            return res
        print(f"  rpc retry {a}: {errs[0]['error']}", file=sys.stderr)
        time.sleep(3 * (a + 1))
    raise SystemExit("chain-getters: never succeeded")


def call(to, data, i):
    return {"jsonrpc": "2.0", "id": i, "method": "eth_call",
            "params": [{"to": to, "data": data}, "latest"]}


# keccak selectors, hard-coded from the ABI text (no shared code):
#   virtualTokenReserves() 0x1655bc62   virtualQuoteReserves() 0xa0640c83
#   realTokenReserves()    0x5c25c6dd   realQuoteReserves()    0xc196c7c5
#   complete()             0x522e1177   totalSupply()          0x18160ddd
#   balanceOf(address)     0x70a08231
batch = [
    call(CURVE, "0x1655bc62", 0),
    call(CURVE, "0xa0640c83", 1),
    call(CURVE, "0x5c25c6dd", 2),
    call(CURVE, "0xc196c7c5", 3),
    call(CURVE, "0x522e1177", 4),
    call(TOKEN, "0x18160ddd", 5),
    call(TOKEN, "0x70a08231" + DEPLOYER[2:].rjust(64, "0"), 6),
    call(TOKEN, "0x70a08231" + CURVE[2:].rjust(64, "0"), 7),
    {"jsonrpc": "2.0", "id": 8, "method": "eth_blockNumber", "params": []},
]
res = rpc(batch)
by = {r["id"]: r["result"] for r in res}
vT = int(by[0], 16); vQ = int(by[1], 16); rT = int(by[2], 16); rQ = int(by[3], 16)
complete = int(by[4], 16) == 1
supply = int(by[5], 16); balDep = int(by[6], 16); balCurve = int(by[7], 16)
head = int(by[8], 16)

T = 10**27
V = 4292000000000000000
S = 793100000000000000000000000
vT0 = 1073000000000000000000000000
POOL_SEED = 206886011183597390493942218

out = {
    "head": head,
    "virtualTokenReserves": vT,
    "virtualQuoteReserves": vQ,
    "realTokenReserves": rT,
    "realQuoteReserves": rQ,
    "complete": complete,
    "marketCapWei": vQ * T // vT,
    "raiseWei": rQ,
    "priceWeiPerToken": vQ * 10**18 // vT,
    "graduationTargetWei": V * S // (vT0 - S),
    "invariant_vT_minus_rT": vT - rT,
    "invariant_vT0_minus_S": vT0 - S,
    "invariant_vQ_minus_rQ": vQ - rQ,
    "V": V,
    "totalSupply": supply,
    "balanceOf_deployer": balDep,
    "balanceOf_curve": balCurve,
    "deployer_plus_curve": balDep + balCurve,
    "remainder": supply - balDep - balCurve,
    "holderCountProved": 1 if (supply - balDep - balCurve) == 0 else None,
    "lockedTokens": balCurve - POOL_SEED,
}
print(json.dumps({k: (str(v) if isinstance(v, int) else v) for k, v in out.items()}, indent=2))
