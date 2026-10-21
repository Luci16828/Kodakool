import { createHmac, pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Crypto } from "./auth.ts";

/**
 * Node implementation of the `Crypto` provider: passwords are memory-hard scrypt
 * (`scrypt$salt$hash`); verification also accepts `pbkdf2$` hashes so a store created
 * by the browser worker can be read by the networked server.
 */

const SCRYPT_KEYLEN = 32;
const PBKDF2_ITERATIONS = 600_000;

export const nodeCrypto: Crypto = {
  randomHex: (bytes) => randomBytes(bytes).toString("hex"),

  hashPassword: async (password) => {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
    return `scrypt$${salt}$${hash}`;
  },

  verifyPassword: async (password, stored) => {
    const [scheme, salt, hash] = stored.split("$");
    if (!salt || !hash) return false;
    const want = Buffer.from(hash, "hex");
    let got: Buffer;
    if (scheme === "scrypt") got = scryptSync(password, salt, want.length);
    else if (scheme === "pbkdf2") {
      // the salt is stored hex-encoded (the worker derives with the decoded bytes)
      got = pbkdf2Sync(password, Buffer.from(salt, "hex"), PBKDF2_ITERATIONS, want.length, "sha256");
    } else return false;
    return want.length === got.length && timingSafeEqual(want, got);
  },

  refreshHash: async (v) => createHmac("sha256", "kodakool-refresh").update(v).digest("hex"),
};
