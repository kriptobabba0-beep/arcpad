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

/* ===========================================================================
 *  ONE GATEWAY WAS ONE POINT OF FAILURE, AND IT FAILED.
 * ===========================================================================
 *
 * MEASURED IN PRODUCTION (2026-08-11, from the deployment itself):
 *
 *   ipfs.io                curl: (28) timed out after 12000 ms, 0 bytes
 *   gateway.pinata.cloud   200  image/png  7826b  3.7s
 *   cloudflare-ipfs.com    curl: (6) Could not resolve host
 *
 * `ipfs.io` — the value this file has defaulted to since it was written —
 * answers NOTHING from the server. Not slowly: not at all. Because the default
 * was a single string, that took down BOTH paths at once: the browser could
 * not load one token image, and the server could not resolve one metadata
 * document, so every card on the site fell back to its gradient. A launchpad
 * with no artwork anywhere, and no error visible in any log.
 *
 * The lesson is not "ipfs.io is bad" — it is that a public gateway is
 * infrastructure we do not run, and treating one of them as a constant makes
 * its downtime OUR downtime. So this is an ordered LIST and every consumer
 * tries the next one when the current one does not answer.
 *
 * ORDERED, NOT A SET. Pinata is first because that is where our own pins live:
 * it can serve a CID the moment we upload it, while a public gateway must
 * first find it on the DHT — which is why a freshly pinned image appeared
 * broken for minutes even when the gateway was up.
 */
export const DEFAULT_IPFS_GATEWAYS = [
  'https://gateway.pinata.cloud',
  'https://dweb.link',
  'https://w3s.link',
  'https://ipfs.io',
] as const

/** Kept as a name because `MAINNET-READINESS.md` and the runbooks cite it. */
export const DEFAULT_IPFS_GATEWAY = DEFAULT_IPFS_GATEWAYS[0]

/**
 * Every gateway origin we will talk to, in the order we will try them.
 *
 * `process.env.NEXT_PUBLIC_IPFS_GATEWAY` is written out in full, deliberately:
 * Next inlines `NEXT_PUBLIC_*` into the client bundle by TEXTUAL replacement
 * of `process.env.NEXT_PUBLIC_FOO`, so a dynamic read (`process.env[name]`)
 * would be `undefined` in the browser and this would silently fall back to the
 * default there while working on the server. Same reason as `lib/addresses.ts`.
 *
 * A CONFIGURED GATEWAY GOES FIRST AND DOES NOT REPLACE THE LIST. An operator
 * pointing at their own gateway wants it preferred, not wants the site to go
 * dark when it restarts. It is de-duplicated against the defaults so naming
 * one of them does not make it appear twice.
 *
 * A MALFORMED VALUE IS IGNORED RATHER THAN THROWING. This is read while
 * rendering a token card; a typo in an env var must not take a page down.
 */
export function ipfsGatewayOrigins(): readonly string[] {
  const defaults = DEFAULT_IPFS_GATEWAYS.map((gateway) => new URL(gateway).origin)
  const configured = process.env.NEXT_PUBLIC_IPFS_GATEWAY
  if (configured === undefined || configured === '') return defaults
  let preferred: string
  try {
    preferred = new URL(configured).origin
  } catch {
    return defaults
  }
  return [preferred, ...defaults.filter((origin) => origin !== preferred)]
}

/**
 * The FIRST gateway — the one tried before any other.
 *
 * Callers that need "where would this be fetched from" rather than "every
 * place it could be fetched from" use this. Nothing security-relevant may:
 * an allow-list built from this alone would reject a URL we ourselves
 * produced from the second gateway.
 */
export function ipfsGatewayOrigin(): string {
  return ipfsGatewayOrigins()[0] as string
}

/**
 * WHERE THE BROWSER ASKS FOR ARTWORK: OUR OWN ORIGIN.
 *
 * NOT a gateway URL, and this is the second half of the same production
 * failure. Chrome refused the image even from a gateway that answered:
 *
 *   GET https://ipfs.io/ipfs/QmWcPGQ… => net::ERR_BLOCKED_BY_ORB
 *
 * Opaque Response Blocking. A cross-origin `<img>` whose response does not
 * carry a believable image content type is discarded by the browser before
 * our code sees it — and a gateway serving a bare CID has no filename to
 * infer a type from, so it says `application/octet-stream` and Chrome is
 * right to refuse it. NOTHING on our side can fix that from the client:
 * `onError` fires and the artwork is simply gone.
 *
 * `/api/ipfs/<cid>` makes the response OURS. The route sniffs the bytes,
 * names the type itself, and serves it same-origin — so the picture no longer
 * depends on how a stranger's gateway labels it, `img-src` shrinks to `'self'`,
 * and no visitor's IP address is handed to a public gateway to load a page.
 */
export const IPFS_PROXY_PREFIX = '/api/ipfs/'

/**
 * `<origin>/ipfs/` for a given gateway — what a CID is appended to.
 *
 * A trailing-slash join done once, here, instead of at each call site: the two
 * sites that built a URL from this used different shapes (`${gateway}/ipfs/…`
 * and `${GATEWAY}${path}` where the constant already ended in `/ipfs/`), which
 * is how they came to hold different values in the first place.
 */
export function ipfsPathPrefix(origin: string = ipfsGatewayOrigin()): string {
  return `${origin}/ipfs/`
}
