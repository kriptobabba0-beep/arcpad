"""Paced, batched JSON-RPC reader for Arc testnet.

Deliberately raw: no viem, no `packages/shared`, no indexer decoders. The point
of this file is to be a SECOND opinion on the chain, so it must not share code
with anything it is checking.

Arc rate-limits concurrent *and* sequential calls, and answers 403 to the
default urllib User-Agent, so every request here is (a) batched, (b) paced,
(c) identified.

usage as a library:
    from arc_rpc import rpc, call, head, logs
"""

import json
import sys
import time
import urllib.request

RPC = "https://rpc.testnet.arc.network"
UA = "arcpad-integration/2"
PACE_S = 1.2
_last = [0.0]


def rpc(payload, tries=8):
    """One HTTP request carrying one or many JSON-RPC objects."""
    for attempt in range(tries):
        wait = PACE_S - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        req = urllib.request.Request(
            RPC,
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json", "user-agent": UA},
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                res = json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            print(f"  [rpc] http retry {attempt}: {e}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))
            continue
        items = res if isinstance(res, list) else [res]
        errs = [i for i in items if isinstance(i, dict) and "error" in i]
        if not errs:
            return res
        print(f"  [rpc] err retry {attempt}: {errs[0]['error']}", file=sys.stderr)
        time.sleep(3 * (attempt + 1))
    raise SystemExit("rpc: exhausted retries")


# MEASURED on Arc testnet 2026-08-08: a single HTTP request carrying 20
# `eth_call` objects is refused with -32005 `rate limit exceeded` and STAYS
# refused across eight retries with a 3/6/9/... second ladder -- i.e. the limit
# counts JSON-RPC OBJECTS, not HTTP requests, so batching does not buy an
# exemption. 15 in one request went through. 10 is the size used here.
BATCH = 10


def calls(items, block="latest"):
    """items: list of (to, data). Returns list of hex results, order preserved.

    Chunked, because Arc's rate limit counts JSON-RPC objects rather than HTTP
    requests; see BATCH.
    """
    out = []
    for start in range(0, len(items), BATCH):
        chunk = items[start : start + BATCH]
        payload = [
            {
                "jsonrpc": "2.0",
                "id": i,
                "method": "eth_call",
                "params": [{"to": to, "data": data}, block],
            }
            for i, (to, data) in enumerate(chunk)
        ]
        res = rpc(payload)
        by_id = {r["id"]: r["result"] for r in res}
        out.extend(by_id[i] for i in range(len(chunk)))
    return out


def call(to, data, block="latest"):
    return calls([(to, data)], block)[0]


def head():
    return int(rpc({"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []})["result"], 16)


def logs(address, from_block, to_block, topics=None):
    p = {"address": address, "fromBlock": hex(from_block), "toBlock": hex(to_block)}
    if topics:
        p["topics"] = topics
    return rpc({"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs", "params": [p]})["result"]


def receipt(txhash):
    return rpc({"jsonrpc": "2.0", "id": 1, "method": "eth_getTransactionReceipt", "params": [txhash]})["result"]


def u256(hexstr, word=0):
    h = hexstr[2:]
    return int(h[word * 64 : (word + 1) * 64], 16)


def addr(hexstr, word=0):
    return "0x" + hexstr[2:][word * 64 : (word + 1) * 64][24:]
