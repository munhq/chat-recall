/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cloud API origin, e.g. https://chat-recall.munhq.com/api. Unset = local mode (vite proxy '/api'). */
  readonly VITE_API_BASE?: string;
  /** Keycloak realm issuer, e.g. https://auth.munhq.com/realms/munhq. Set = cloud auth on. */
  readonly VITE_OIDC_ISSUER?: string;
  /** OIDC client id (default: chat-recall-web). */
  readonly VITE_OIDC_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
