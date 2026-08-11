import { ARC_TESTNET_CHAIN_ID, getArcChain } from '@arcpad/shared/browser'
import type { NextConfig } from 'next'
import { ipfsGatewayOrigins } from './lib/ipfs'

/**
 * SECURITY HEADERS, AND A CSP THAT IS MEASURED RATHER THAN DECLARED.
 *
 * A launchpad is a place people arrive at with money. A single third-party
 * script on this origin can rewrite a transaction's `to` address after the
 * quote has been shown and before the wallet opens it, and nothing on screen
 * would look different. So the rule is that this origin loads NOTHING it does
 * not serve, and `e2e/audit/network.spec.ts` proves it by collecting every
 * request the browser makes and asserting the host set EXACTLY equals
 * {this origin, the configured RPC, the configured IPFS gateway}.
 *
 * `'unsafe-eval'` IS ABSENT AND MUST STAY ABSENT. Next's bootstrap needs
 * `'unsafe-inline'` for its inline hydration scripts; wagmi and viem do not
 * evaluate strings. The audit spec fails on any CSP violation in the console,
 * so if that ever stops being true the suite says so instead of a user finding
 * out.
 *
 * THE RPC AND GATEWAY ARE READ FROM THE SAME ENV THE APP USES. A hardcoded
 * host here would silently blackhole every read for anybody who points the app
 * at their own node -- the failure would surface as "the site shows dashes",
 * which nobody would connect to a header.
 */

function originOf(raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw.trim() === '') return fallback
  try {
    return new URL(raw.trim()).origin
  } catch {
    return fallback
  }
}

/**
 * THE FALLBACK RPC COMES FROM THE REGISTRY, NOT FROM A LITERAL HERE.
 *
 * The first version pasted `https://rpc.testnet.arc.io` into this file and
 * `packages/shared/test/chain-registry.test.ts` caught it: the chain id and
 * every Arc host live in `packages/shared/src/chain.ts` and nowhere else. That
 * rule is not tidiness. A second copy of a host is a second thing to update on
 * a network change, and the one that gets missed is the one in a SECURITY
 * HEADER -- where being wrong means every RPC call is blocked by our own CSP
 * and the site silently shows dashes.
 *
 * `next.config.ts` is compiled by Next itself, so importing the workspace
 * package here is the same path the app uses.
 */
const registryRpc = getArcChain(ARC_TESTNET_CHAIN_ID).rpcUrls.default.http[0] as string

const rpcOrigin = originOf(process.env.NEXT_PUBLIC_ARC_RPC_URL, registryRpc)
/*
 * THE GATEWAYS COME FROM `lib/ipfs.ts`, THE SAME FUNCTION THE APP CALLS.
 *
 * It used to be a second copy of the read plus a second copy of the default
 * here -- and the app's IMAGE path was a THIRD copy that read no env at all,
 * so a configured gateway opened `img-src` to one origin while every <img>
 * still pointed at ipfs.io. Every token image was then refused by this very
 * header. One function, one default, one list.
 *
 * ---------------------------------------------------------------------------
 * `img-src` NO LONGER NAMES A GATEWAY, AND THAT IS THE POINT.
 *
 * Token artwork is fetched by `/api/ipfs/…` on the server and served from
 * this origin, so the browser never talks to a gateway at all. Three things
 * follow, and each was a real defect before:
 *
 *   - A gateway that labels a CID `application/octet-stream` can no longer
 *     make Chrome discard the image (`ERR_BLOCKED_BY_ORB`, measured live).
 *   - Changing `NEXT_PUBLIC_IPFS_GATEWAY` can no longer desynchronise this
 *     header from where the images actually come from.
 *   - No visitor's IP address is handed to a public gateway to load a page.
 *
 * `connect-src` still names them: nothing in the browser fetches a gateway
 * today, but the value is what an operator would have to widen if anything
 * ever did, and a header that quietly forbids what the code allows is the
 * failure this whole file is a monument to.
 */
const gatewayOrigins = ipfsGatewayOrigins().join(' ')

const csp = [
  "default-src 'self'",
  `connect-src 'self' ${rpcOrigin} ${gatewayOrigins}`,
  "img-src 'self' data:",
  // The fonts are OURS (Task 6 self-hosts them). No `https:` here, and no
  // `fonts.gstatic.com`: a font request to a third party leaks every visitor's
  // IP to it on every page load.
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
]

/**
 * AN ESCAPE HATCH THAT CANNOT ESCAPE A RELEASE.
 *
 * `next build` type-checks the WHOLE tsconfig project, test files included, so
 * type errors in files this app never ships still stop the build. That is
 * correct behaviour for a release gate and it is why `scripts/release-gate.ts`
 * runs a real build with this flag UNSET.
 *
 * The end-to-end harness needs a server to exist even while another track's
 * test files are mid-flight, so it may set this -- and when it does, the
 * harness prints the errors it stepped over. The variable name is deliberately
 * long and ugly: nobody sets it by accident, and `web/test/releaseGate.test.ts`
 * asserts the release gate refuses to run with it set.
 */
export const TYPECHECK_ESCAPE_HATCH = 'ARCPAD_E2E_UNSAFE_SKIP_TYPECHECK'

const nextConfig: NextConfig = {
  transpilePackages: ['@arcpad/shared'],
  typescript: {
    ignoreBuildErrors: process.env[TYPECHECK_ESCAPE_HATCH] === '1',
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }]
  },
}

export default nextConfig
