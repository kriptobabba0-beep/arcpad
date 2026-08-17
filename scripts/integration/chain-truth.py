"""Integration harness: derive the site's four headline numbers from the chain
alone, independently of the indexer.

Deliberately NOT written against `packages/shared` or the indexer's decoders --
the whole point is that this side must not share code with the side under test.
Raw JSON-RPC, raw hex slicing.

Reads are BATCHED (many JSON-RPC objects per HTTP request) and paced, because
Arc rate-limits concurrent *and* sequential calls.

usage: python chain-truth.py <rpc-url> <token> <curve> <startBlock>
"""

import json
import sys
import time
import urllib.request

RPC, TOKEN, CURVE, START = sys.argv[1], sys.argv[2].lower(), sys.argv[3].lower(), int(sys.argv[4])

TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
SPAN = 10_000
BATCH = 10
PACE_S = 1.0


def rpc(payload):
    req = urllib.request.Request(
        RPC,
        data=json.dumps(payload).encode(),
        # MEASURED: Arc's RPC edge answers 403 Forbidden to the default
        # `Python-urllib/3.11` User-Agent, on the very first request, before any
        # rate limit is involved. Anything reading Arc from a non-browser HTTP
        # client has to say who it is.
        headers={"content-type": "application/json", "user-agent": "arcpad-integration/1"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def head():
    return int(rpc({"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []})["result"], 16)


def transfer_logs(lo, hi):
    """Every Transfer log emitted BY THE TOKEN across [lo, hi]."""
    out = []
    ranges = []
    b = lo
    while b <= hi:
        ranges.append((b, min(b + SPAN - 1, hi)))
        b += SPAN
    for i in range(0, len(ranges), BATCH):
        chunk = ranges[i : i + BATCH]
        payload = [
            {
                "jsonrpc": "2.0",
                "id": j,
                "method": "eth_getLogs",
                "params": [
                    {
                        "fromBlock": hex(f),
                        "toBlock": hex(t),
                        "address": TOKEN,
                        "topics": [TRANSFER],
                    }
                ],
            }
            for j, (f, t) in enumerate(chunk)
        ]
        for attempt in range(8):
            res = rpc(payload)
            errs = [r for r in res if "error" in r]
            if not errs:
                break
            print(f"  retry {attempt}: {errs[0]['error']}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))
        else:
            raise SystemExit("chain-truth: getLogs never succeeded")
        for r in res:
            out.extend(r["result"])
        print(f"  scanned {chunk[0][0]}..{chunk[-1][1]}  logs so far {len(out)}", file=sys.stderr)
        time.sleep(PACE_S)
    return out


def addr(topic):
    return "0x" + topic[-40:]


def main():
    h = head()
    print(f"head {h}", file=sys.stderr)
    logs = transfer_logs(START, h)
    print(f"transfer logs: {len(logs)}", file=sys.stderr)

    # Balances reconstructed from the log stream alone.
    bal = {}
    for lg in logs:
        frm, to = addr(lg["topics"][1]), addr(lg["topics"][2])
        val = int(lg["data"], 16)
        bal[frm] = bal.get(frm, 0) - val
        bal[to] = bal.get(to, 0) + val
    ZERO = "0x" + "0" * 40
    bal.pop(ZERO, None)  # mint source
    holders = {a: v for a, v in bal.items() if v > 0}

    # Cross-check every reconstructed balance against `balanceOf` at head.
    payload = [
        {
            "jsonrpc": "2.0",
            "id": i,
            "method": "eth_call",
            "params": [{"to": TOKEN, "data": "0x70a08231" + a[2:].rjust(64, "0")}, "latest"],
        }
        for i, a in enumerate(holders)
    ]
    onchain = {}
    if payload:
        res = rpc(payload)
        for r in res:
            onchain[list(holders)[r["id"]]] = int(r["result"], 16)

    print(json.dumps(
        {
            "head": h,
            "transferLogs": len(logs),
            "holderCount": len(holders),
            "holders": {a: str(v) for a, v in sorted(holders.items())},
            "balanceOf": {a: str(v) for a, v in sorted(onchain.items())},
            "agree": all(onchain.get(a) == v for a, v in holders.items()),
        },
        indent=2,
    ))


main()
