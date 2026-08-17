"""An INDEPENDENT re-implementation of arcpad's curve arithmetic.

Written from the algorithm as documented (pump.fun's IDL order of operations),
not by importing anything from `contracts/` or `indexer/`. If this file and the
chain agree, two implementations agree; if it merely imported the repo's
decoders it would only prove the chain is self-consistent.

The three rules that make this different from a naive AMM model:
  * `quoteBuyCost` is `floor(...) + 1`, which is NOT `mulDivRoundingUp`.
  * `quoteBuyTokensOut` subtracts 1 from the net FIRST.
  * fees are SUMMED FROM PARTS -- `feeOn(x,95) + feeOn(x,30)`, never
    `feeOn(x,125)` -- and on the exact-quote-in path they are charged on the
    PRE-correction net.
"""

BPS = 10_000
P_BPS = 95
C_BPS = 30


def ceil_div(a, b):
    return -(-a // b)


def fee_on(amount, bps):
    return ceil_div(amount * bps, BPS)


def fees_from_parts(amount, p_bps=P_BPS, c_bps=C_BPS):
    """SUMMED, never divided from 125. On the old factory's smoke this was the
    difference between …635 and …634 on trade #1."""
    return fee_on(amount, p_bps), (fee_on(amount, c_bps) if c_bps else 0)


def quote_buy_cost(tokens_out, vq, vt):
    assert 0 < tokens_out < vt
    return (tokens_out * vq) // (vt - tokens_out) + 1


def quote_buy_tokens_out(net, vq, vt):
    assert net > 1
    n = net - 1
    return (n * vt) // (vq + n)


def quote_sell_proceeds(tokens_in, vq, vt):
    assert tokens_in > 0
    return (tokens_in * vq) // (vt + tokens_in)


def corrected_net_quote_in(gross, p_bps=P_BPS, c_bps=C_BPS):
    """Steps 1-3 of the chain algorithm. Returns (net, protocolFee, creatorFee).

    Fees are computed on the PRE-correction net and NOT recomputed after the
    correction: recomputing differs on 1.1851% of [1, 1e6] at (95,30).
    """
    total_bps = p_bps + c_bps
    net = (gross * BPS) // (total_bps + BPS)
    pf, cf = fees_from_parts(net, p_bps, c_bps)
    overshoot = net + pf + cf - gross
    if overshoot > 0:
        assert overshoot < net, "NetTooSmall"
        net -= overshoot
    return net, pf, cf


class Curve:
    """Mirror of BondingCurve's ledger. Every method returns the Trade event
    fields the chain should emit, so the comparison is field-by-field."""

    def __init__(self, vt, vq, s, pool_seed):
        self.vt = vt
        self.vq = vq
        self.rt = s
        self.rq = 0
        self.vt0 = vt
        self.s = s
        self.pool_seed = pool_seed
        self.complete = False

    def _settle_buy(self, tokens_out, curve_in, pf, cf, gross):
        self.vq += curve_in
        self.vt -= tokens_out
        self.rt -= tokens_out
        self.rq += curve_in
        if self.rt == 0:
            self.complete = True
        return {
            "isBuy": True,
            "tokenAmount": tokens_out,
            "quoteAmount": curve_in,
            "protocolFee": pf,
            "creatorFee": cf,
            "vT": self.vt,
            "vQ": self.vq,
            "rT": self.rt,
            "rQ": self.rq,
            "refund": gross - curve_in - pf - cf,
            "completed": self.complete,
        }

    def buy_exact_quote_in(self, gross):
        curve_in, pf, cf = corrected_net_quote_in(gross)
        tokens_out = quote_buy_tokens_out(curve_in, self.vq, self.vt)
        clamped = False
        if tokens_out > self.rt:
            # The clamp: the WHOLE remaining reserve is sold and the principal
            # changes, so the fee is retaken on the NEW principal. That is not
            # "recomputing the returned net's fee" (forbidden) -- it is another
            # principal's fee.
            clamped = True
            tokens_out = self.rt
            curve_in = quote_buy_cost(tokens_out, self.vq, self.vt)
            pf, cf = fees_from_parts(curve_in)
        ev = self._settle_buy(tokens_out, curve_in, pf, cf, gross)
        ev["clamped"] = clamped
        return ev

    def buy_exact_tokens_out(self, tokens_out, gross):
        cost = quote_buy_cost(tokens_out, self.vq, self.vt)
        pf, cf = fees_from_parts(cost)
        assert cost + pf + cf <= gross, "SlippageExceeded"
        ev = self._settle_buy(tokens_out, cost, pf, cf, gross)
        ev["clamped"] = False
        return ev

    def sell_exact_tokens_in(self, tokens_in):
        proceeds = quote_sell_proceeds(tokens_in, self.vq, self.vt)
        pf, cf = fees_from_parts(proceeds)
        assert proceeds > pf + cf, "ProceedsTooSmall"
        net_out = proceeds - pf - cf
        self.vq -= proceeds
        self.vt += tokens_in
        self.rt += tokens_in
        self.rq -= proceeds
        return {
            "isBuy": False,
            "tokenAmount": tokens_in,
            "quoteAmount": proceeds,
            "protocolFee": pf,
            "creatorFee": cf,
            "vT": self.vt,
            "vQ": self.vq,
            "rT": self.rt,
            "rQ": self.rq,
            "netOut": net_out,
            "completed": self.complete,
        }

    def invariants(self, v):
        """`vT - rT == vT0 - S` and `vQ - rQ == V` must hold at EVERY state."""
        return self.vt - self.rt == self.vt0 - self.s, self.vq - self.rq == v
