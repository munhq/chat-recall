/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cloud API origin, e.g. https://chat-recall.munhq.com/api. Unset = local mode (vite proxy '/api'). */
  readonly VITE_API_BASE?: string;
  /** Set (any value) = cloud build: embedded better-auth login on. */
  readonly VITE_CLOUD?: string;
  /** Legacy (Keycloak era): also counts as cloud so old build recipes fail loud at login. */
  readonly VITE_OIDC_ISSUER?: string;
  /** GlitchTip crash-reporting DSN (public key), baked at build. */
  readonly VITE_GLITCHTIP_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
