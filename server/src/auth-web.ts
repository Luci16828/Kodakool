import type { Crypto } from "./auth.ts";

/**
 * Web (worker) implementation of the `Crypto` provider — pure WebCrypto, no Node APIs:
 * passwords are PBKDF2-SHA256 (`pbkdf2$salt$hash`, OWASP iteration count), refresh tokens
 * are keyed with HMAC-SHA256, randomness from `crypto.getRandomValues`.
 *
 * The worker's local store only ever mints `pbkdf2$`; the networked server keeps minting
 * `scrypt$` (nodeCrypto verifies BOTH schemes, so a worker-created store stays readable
 * if it is ever exported to a server).
 */

const PBKDF2_ITERATIONS = 600_000;
const text = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** constant-time compare: never returns early */
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(password: string, saltHex: string, keyLen: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", text.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    keyLen * 8,
  );
  return new Uint8Array(bits);
}

export const webCrypto: Crypto = {
  randomHex: (bytes) => {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return toHex(buf);
  },

  hashPassword: async (password) => {
    const salt = webCrypto.randomHex(16);
    const hash = await pbkdf2(password, salt, 32);
    return `pbkdf2$${salt}$${toHex(hash)}`;
  },

  verifyPassword: async (password, stored) => {
    const [scheme, salt, hash] = stored.split("$");
    if (scheme !== "pbkdf2" || !salt || !hash) return false;
    const want = fromHex(hash);
    const got = await pbkdf2(password, salt, want.length);
    return equal(want, got);
  },

  refreshHash: async (v) => {
    const key = await crypto.subtle.importKey(
      "raw",
      text.encode("kodakool-refresh"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, text.encode(v));
    return toHex(new Uint8Array(sig));
  },
};
