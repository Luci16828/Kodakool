import type { Db } from "./db.ts";
import { SignJWT, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Config } from "./config.ts";
import type { UserRow } from "./db.ts";
import { userById } from "./db.ts";

/**
 * Session auth built ONLY from standard primitives:
 * - passwords: a memory-hard / PBKDF KDF behind the `Crypto` provider below, stored as
 *   `<scheme>$salt$hash`, compared in constant time — no custom crypto, no home-grown schemes.
 * - access tokens: short-lived HS256 JWTs (jose — WebCrypto-based, portable).
 * - refresh tokens: random 256-bit values, stored keyed-hashed, rotated on every refresh.
 */

/**
 * The environment-specific crypto the auth flows run on.
 * `nodeCrypto` (auth-node.ts) uses node:crypto scrypt; `webCrypto` (auth-web.ts) uses
 * WebCrypto PBKDF2 — the worker's local store only ever mints `pbkdf2$`, the networked
 * server keeps minting `scrypt$`, and each provider verifies its own scheme.
 */
export interface Crypto {
  /** hex-encoded random bytes (refresh tokens, salts) */
  randomHex(bytes: number): string;
  /** mint a stored password hash (`<scheme>$salt$hash`) */
  hashPassword(password: string): Promise<string>;
  /** constant-time verification of a stored hash */
  verifyPassword(password: string, stored: string): Promise<boolean>;
  /** keyed digest a refresh token is stored as (rotation lookup key) */
  refreshHash(v: string): Promise<string>;
}

const ISSUER = "kodakool-server";
const AUDIENCE = "kodakool";
const ACCESS_TTL_S = 24 * 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;

export interface AccessTokenUser {
  sub: string;
  name: string;
}

export async function signAccessToken(secret: Uint8Array, user: AccessTokenUser): Promise<string> {
  return new SignJWT({ name: user.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_S}s`)
    .sign(secret);
}

export async function verifyAccessToken(secret: Uint8Array, token: string): Promise<AccessTokenUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: AUDIENCE });
    if (typeof payload.sub !== "string") return null;
    return { sub: payload.sub, name: typeof payload.name === "string" ? payload.name : "" };
  } catch {
    return null;
  }
}

export interface AuthResult {
  token: string;
  refresh: string;
  user: { id: string; name: string; email: string | null };
}

export function publicUser(u: UserRow): AuthResult["user"] {
  return { id: u.id, name: u.name, email: u.email };
}

/** issue an access token + a fresh (hashed) refresh session for a user */
export async function issueSession(db: Db, kdf: Crypto, secret: Uint8Array, user: UserRow): Promise<AuthResult> {
  const refresh = kdf.randomHex(32);
  db.prepare("INSERT INTO sessions (id, user_id, hash, expires) VALUES (?, ?, ?, ?)").run(
    crypto.randomUUID(),
    user.id,
    await kdf.refreshHash(refresh),
    Date.now() + REFRESH_TTL_S * 1000,
  );
  return {
    token: await signAccessToken(secret, { sub: user.id, name: user.name }),
    refresh,
    user: publicUser(user),
  };
}

/** rotate: consume the presented refresh token, mint a new pair */
export async function rotateSession(
  db: Db,
  kdf: Crypto,
  secret: Uint8Array,
  refresh: string,
): Promise<AuthResult | null> {
  const row = db
    .prepare("SELECT id, user_id FROM sessions WHERE hash = ? AND expires > ?")
    .get(await kdf.refreshHash(refresh), Date.now()) as { id: string; user_id: string } | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
  const user = userById(db, row.user_id);
  if (!user) return null;
  return issueSession(db, kdf, secret, user);
}

export async function dropSession(db: Db, kdf: Crypto, refresh: string): Promise<void> {
  db.prepare("DELETE FROM sessions WHERE hash = ?").run(await kdf.refreshHash(refresh));
}

/** Hono middleware: require a valid bearer access token, attach the user row. */
export function requireAuth(cfg: Config, db: Db): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const verified = token === "" ? null : await verifyAccessToken(cfg.secret, token);
    const user = verified === null ? null : userById(db, verified.sub);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    await next();
  };
}
