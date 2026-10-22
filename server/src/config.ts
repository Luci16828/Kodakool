/**
 * Server configuration, read from the environment.
 *
 * - SECRET: signing key for session JWTs (min 32 chars).
 * - DATA_DIR: directory for the SQLite file.
 * - ALLOW_REGISTER: "0" disables open username/password registration (invite-only servers).
 * - OIDC_ALLOW: comma-separated issuer allow-list; empty allows any issuer.
 * - OIDC_ISSUER + OIDC_CLIENT_ID: the server's own OIDC provider. When BOTH are set,
 *   OIDC is enabled and reported by GET /api/auth/methods so clients can offer a
 *   one-click sign-in with the issuer/client id pre-filled. Without them OIDC is off.
 */
export interface Config {
  port: number;
  host: string;
  dataDir: string;
  secret: Uint8Array;
  allowRegister: boolean;
  /** allowed OIDC issuers; null = any https issuer */
  oidcAllow: string[] | null;
  /** the server's own OIDC provider (both set = OIDC enabled + advertised) */
  oidcIssuer: string | null;
  oidcClientId: string | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const secret = env.SECRET ?? "";
  if (secret.length < 32) {
    throw new Error("SECRET must be set with at least 32 characters");
  }
  const allow = (env.OIDC_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "0.0.0.0",
    dataDir: env.DATA_DIR ?? "./data",
    secret: new TextEncoder().encode(secret),
    allowRegister: (env.ALLOW_REGISTER ?? "1") !== "0",
    oidcAllow: allow.length === 0 ? null : allow,
    oidcIssuer: (env.OIDC_ISSUER ?? "").trim() || null,
    oidcClientId: (env.OIDC_CLIENT_ID ?? "").trim() || null,
  };
}
