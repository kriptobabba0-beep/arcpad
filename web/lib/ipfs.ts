/**
 * THE IPFS GATEWAY, IN ONE PLACE — BECAUSE THE FOURTH COPY WAS A LIVE DEFECT.
 *
 * `next.config.ts` already says the rule, in a comment written about the RPC:
 * *"A second copy of a host is a second thing to update on a network change,
 * and the one that gets missed is the one in a SECURITY HEADER -- where being
 * wrong means every RPC call is blocked by our own CSP and the site silently
 * shows dashes."* The gateway had four copies and the missed one was on the
 * other side of exactly that header.
 *
 * ===========================================================================
 *  WHAT WAS BROKEN, STATED AS THE OPERATOR WOULD HAVE SEEN IT.
 * ===========================================================================
 *
 * Setting `NEXT_PUBLIC_IPFS_GATEWAY=https://my-gateway.example` moved three
 * things and not the fourth:
 *
 *   next.config.ts       CSP `img-src 'self' data: https://my-gateway.example`
 *   lib/metadata.ts      the metadata JSON fetched from my-gateway.example
 *   e2e/audit/network    the allowed host set
 *   TokenArtwork.tsx     `https://ipfs.io/ipfs/…`   <- HARDCODED
 *
 * So every token image was requested from an origin the CSP had just STOPPED
 * allowing, and the browser refused all of them. The whole product loses its
 * artwork the moment anybody uses the documented knob — and the failure looks
 * like a broken gateway rather than a broken config, because the JSON (which
 * moved) still arrives while the image (which did not) does not.
 *
 * `MAINNET-READINESS.md` §3 records this as "`IPFS_GATEWAY` is not
 * configurable". It is the opposite and worse: it is configurable in three
 * places out of four, so the knob does not do nothing — it does half of
 * something, and the half it does breaks the other half.
 *
 * The default lives here and NOWHERE ELSE. `web/test/metadata.test.ts` pins
 * that the CSP's origin and the artwork's origin are the same string for a
 * configured gateway, which is the property no single file can check.
 */

export const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io'

/**
 * The configured gateway's ORIGIN, or the default.
 *
 * `process.env.NEXT_PUBLIC_IPFS_GATEWAY` is written out in full, deliberately:
 * Next inlines `NEXT_PUBLIC_*` into the client bundle by TEXTUAL replacement
 * of `process.env.NEXT_PUBLIC_FOO`, so a dynamic read (`process.env[name]`)
 * would be `undefined` in the browser and this would silently fall back to the
 * default there while working on the server. Same reason as `lib/addresses.ts`.
 *
 * A MALFORMED VALUE FALLS BACK RATHER THAN THROWING. This is read while
 * rendering a token card; a typo in an env var must not take a page down, and
 * the fallback is the same origin the CSP falls back to, so the two cannot
 * disagree even in the error case.
 */
export function ipfsGatewayOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_IPFS_GATEWAY ?? DEFAULT_IPFS_GATEWAY
  try {
    return new URL(configured).origin
  } catch {
    return new URL(DEFAULT_IPFS_GATEWAY).origin
  }
}

/**
 * `<origin>/ipfs/` — what a CID is appended to.
 *
 * A trailing-slash join done once, here, instead of at each call site: the two
 * sites that build a URL from this used different shapes (`${gateway}/ipfs/…`
 * and `${GATEWAY}${path}` where the constant already ended in `/ipfs/`), which
 * is how they came to hold different values in the first place.
 */
export function ipfsPathPrefix(): string {
  return `${ipfsGatewayOrigin()}/ipfs/`
}
