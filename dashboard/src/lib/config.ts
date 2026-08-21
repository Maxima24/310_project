/**
 * Where the dashboard finds the hub.
 *
 * Three deployment shapes, all covered by these two values:
 *
 * | Setup                | VITE_API_BASE            | VITE_WS_URL              |
 * |----------------------|--------------------------|--------------------------|
 * | `pnpm dev`           | unset (Vite proxies)     | unset (same origin)      |
 * | Behind Caddy         | unset (Caddy proxies)    | unset (same origin)      |
 * | Render / split hosts | `https://hub.example.com`| `https://hub.example.com`|
 *
 * Same-origin is the default because it is the better arrangement: no CORS, and the
 * credential is never sent cross-site. Only a split deployment — where the static site
 * and the API have different hostnames, as on Render — needs these set, and then the
 * hub's CORS_ORIGIN must name the dashboard's origin.
 *
 * These are baked in at BUILD time, not read at runtime: Vite substitutes
 * `import.meta.env.*` during the build. Pointing a built bundle at a different hub
 * therefore means rebuilding, which is why the Render blueprint sets them as build
 * environment variables.
 */

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Prefix for REST calls. Defaults to `/api`, which both the Vite dev proxy and the
 * Caddyfile strip before forwarding to the hub.
 *
 * `||` rather than `??`, and the difference is not cosmetic. Compose passes build args
 * as strings, so an unset value arrives as `''` — which `??` accepts, because an empty
 * string is neither null nor undefined. The Caddy build shipped with `VITE_API_BASE: ''`
 * and therefore called `/auth/me` instead of `/api/auth/me`. Caddy proxies only `/api/*`,
 * so those requests fell through to the SPA fallback and came back as index.html with a
 * 200; the dashboard then parsed a web page as JSON and every request failed with a
 * syntax error that named nothing. `||` treats empty as absent, which is what every
 * caller means by it.
 *
 * Note that "same origin" does NOT mean "no prefix" here: both proxies match on `/api`
 * and strip it, so the prefix is how the request is routed, not where it is sent.
 */
export const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE);

/**
 * Exported so the rule can be tested against the values a build actually supplies —
 * `import.meta.env` is fixed at module load and cannot be varied per test case.
 *
 * The second guard is not belt-and-braces: `trimTrailingSlash('/')` is `''`, so a base
 * of `/` — a perfectly natural thing to write for "same origin" — collapses to the same
 * broken empty prefix by a different route.
 */
export function resolveApiBase(raw: string | undefined): string {
  return trimTrailingSlash(raw || '/api') || '/api';
}

/**
 * Origin for the socket.io connection. `/` means "same origin as this page", which is
 * what socket.io expects for a proxied setup.
 */
export const WS_URL = import.meta.env.VITE_WS_URL
  ? trimTrailingSlash(import.meta.env.VITE_WS_URL)
  : '/';

/** True when the hub lives on a different origin, so CORS is in play. */
export const IS_SPLIT_ORIGIN = API_BASE.startsWith('http');
