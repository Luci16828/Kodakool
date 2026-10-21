import type { Db } from "./db.ts";
import * as oidc from "openid-client";
import type { Config } from "./config.ts";
import type { UserRow } from "./db.ts";
import { userByOidc } from "./db.ts";

/**
 * OIDC authorization-code + PKCE, server-mediated: the SPA asks the server to build the
 * authorization URL (openid-client does discovery, PKCE and the id_token validation),
 * redirects the browser to the IdP, and posts the callback's code back for the exchange.
 * The app's own session is minted from the verified IdP identity — the IdP is the single
 * source of truth for who the user is (standard protocol, no custom crypto).
 */

const FLOW_TTL_MS = 10 * 60 * 1000;

export interface OidcBegin {
  state: string;
  url: string;
}

function assertIssuer(cfg: Config, iss: string): URL {
  let u: URL;
  try {
    u = new URL(iss);
  } catch {
    throw new Error("400:issuer must be a URL");
  }
  if (u.protocol !== "https:") throw new Error("400:issuer must be https");
  if (cfg.oidcAllow !== null && !cfg.oidcAllow.includes(u.origin + u.pathname.replace(/\/$/, ""))) {
    throw new Error("400:issuer is not on this server's allow-list");
  }
  return u;
}

async function discover(cfg: Config, iss: string, clientId: string): Promise<oidc.Configuration> {
  const server = assertIssuer(cfg, iss);
  return oidc.discovery(server, clientId);
}

export async function beginFlow(
  db: Db,
  cfg: Config,
  input: { iss: string; clientId: string; redirectUri: string },
): Promise<OidcBegin> {
  const config = await discover(cfg, input.iss, input.clientId);
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  db.prepare(
    "INSERT INTO oidc_flows (state, iss, client_id, verifier, redirect, nonce, expires) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    state,
    config.serverMetadata().issuer,
    input.clientId,
    verifier,
    input.redirectUri,
    nonce,
    Date.now() + FLOW_TTL_MS,
  );
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: input.redirectUri,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { state, url: url.toString() };
}

/** exchange the callback's code for the verified IdP identity and upsert the user */
export async function exchangeFlow(
  db: Db,
  cfg: Config,
  input: { state: string; code: string; redirectUri: string },
): Promise<UserRow> {
  const flow = db
    .prepare("SELECT state, iss, client_id, verifier, redirect, nonce, expires FROM oidc_flows WHERE state = ?")
    .get(input.state) as
    | {
        state: string;
        iss: string;
        client_id: string;
        verifier: string;
        redirect: string;
        nonce: string;
        expires: number;
      }
    | undefined;
  if (!flow) throw new Error("400:unknown or expired login attempt");
  db.prepare("DELETE FROM oidc_flows WHERE state = ?").run(flow.state);
  if (flow.expires < Date.now()) throw new Error("400:login attempt expired");
  if (flow.redirect !== input.redirectUri) throw new Error("400:redirect uri mismatch");

  const config = await discover(cfg, flow.iss, flow.client_id);
  // openid-client validates the authorization response (state), exchanges the code with
  // the PKCE verifier, and validates the id_token signature/iss/aud/exp against the IdP
  const currentUrl = new URL(flow.redirect);
  currentUrl.searchParams.set("code", input.code);
  currentUrl.searchParams.set("state", flow.state);
  const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: flow.verifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
  });
  const claims = tokens.claims();
  if (!claims || typeof claims.sub !== "string") throw new Error("400:id token has no subject");

  const user =
    userByOidc(db, config.serverMetadata().issuer, claims.sub) ??
    upsertOidcUser(db, config.serverMetadata().issuer, claims);
  return user;
}

function upsertOidcUser(db: Db, iss: string, claims: Record<string, unknown>): UserRow {
  const sub = String(claims.sub);
  const email = typeof claims.email === "string" ? claims.email : null;
  const name =
    (typeof claims.name === "string" && claims.name) ||
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    email ||
    sub;
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO users (id, email, name, pass, oidc_iss, oidc_sub, created) VALUES (?, ?, ?, NULL, ?, ?, ?)",
  ).run(id, email, name, iss, sub, Date.now());
  const row = db
    .prepare("SELECT id, email, name, pass, oidc_iss, oidc_sub FROM users WHERE id = ?")
    .get(id) as unknown as UserRow;
  return row;
}
