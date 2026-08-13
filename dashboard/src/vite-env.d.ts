/// <reference types="vite/client" />

/**
 * Typed build-time configuration. Declaring these means a typo in an env var name is a
 * compile error rather than a silently undefined value that falls back to same-origin
 * and produces confusing 404s in a split deployment.
 */
interface ImportMetaEnv {
  /** REST prefix, e.g. `https://hub.example.com`. Defaults to `/api`. */
  readonly VITE_API_BASE?: string;
  /** socket.io origin. Defaults to `/` (same origin). */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
