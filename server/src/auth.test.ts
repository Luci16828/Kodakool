import { describe, expect, it } from "vitest";
import { issueSession, rotateSession, dropSession, signAccessToken, verifyAccessToken } from "./auth.ts";
import { nodeCrypto } from "./auth-node.ts";
import { webCrypto } from "./auth-web.ts";
import { openMemoryDb } from "./db-node.ts";
import { userById } from "./db.ts";

const secret = new TextEncoder().encode("0123456789012345678901234567890123");

describe("password hashing (scrypt)", () => {
  it("round-trips the correct password", async () => {
    const stored = await nodeCrypto.hashPassword("correct horse");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await nodeCrypto.verifyPassword("correct horse", stored)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const stored = await nodeCrypto.hashPassword("right");
    expect(await nodeCrypto.verifyPassword("wrong", stored)).toBe(false);
  });

  it("rejects tampered storage", async () => {
    const stored = await nodeCrypto.hashPassword("right");
    // flip the last hex digit to a DIFFERENT one (a same-char replace would be a no-op)
    const last = stored.slice(-1);
    const tampered = stored.slice(0, -1) + (last === "f" ? "e" : "f");
    expect(await nodeCrypto.verifyPassword("right", tampered)).toBe(false);
    expect(await nodeCrypto.verifyPassword("right", "plain")).toBe(false);
  });

  it("salts: two hashes of the same password differ", async () => {
    expect(await nodeCrypto.hashPassword("same")).not.toBe(await nodeCrypto.hashPassword("same"));
  });
});

describe("worker crypto (WebCrypto PBKDF2)", () => {
  it("round-trips through its own scheme", async () => {
    const stored = await webCrypto.hashPassword("worker pass");
    expect(stored.startsWith("pbkdf2$")).toBe(true);
    expect(await webCrypto.verifyPassword("worker pass", stored)).toBe(true);
    expect(await webCrypto.verifyPassword("wrong", stored)).toBe(false);
  });

  it("node verifies a worker-minted hash (store parity)", async () => {
    const stored = await webCrypto.hashPassword("shared secret");
    expect(await nodeCrypto.verifyPassword("shared secret", stored)).toBe(true);
  });

  it("worker rejects a scrypt-minted hash (scheme gate)", async () => {
    const stored = await nodeCrypto.hashPassword("node only");
    expect(await webCrypto.verifyPassword("node only", stored)).toBe(false);
  });
});

describe("access tokens (HS256 JWT)", () => {
  it("round-trips the user identity", async () => {
    const token = await signAccessToken(secret, { sub: "u1", name: "Ann" });
    expect(await verifyAccessToken(secret, token)).toEqual({ sub: "u1", name: "Ann" });
  });

  it("rejects foreign signatures and garbage", async () => {
    const token = await signAccessToken(secret, { sub: "u1", name: "Ann" });
    const other = new TextEncoder().encode("9999999999999999999999999999999999");
    expect(await verifyAccessToken(other, token)).toBeNull();
    expect(await verifyAccessToken(secret, "not-a-jwt")).toBeNull();
  });
});

describe("refresh sessions", () => {
  it("issues, rotates (consumes the old token) and drops", async () => {
    const db = openMemoryDb();
    db.prepare(
      "INSERT INTO users (id, email, name, pass, oidc_iss, oidc_sub, created) VALUES (?, ?, ?, ?, NULL, NULL, ?)",
    ).run("u1", "a@b.de", "Ann", null, Date.now());
    const user = userById(db, "u1")!;
    const first = await issueSession(db, nodeCrypto, secret, user);
    expect(first.user).toEqual({ id: "u1", name: "Ann", email: "a@b.de" });

    const rotated = await rotateSession(db, nodeCrypto, secret, first.refresh);
    expect(rotated).not.toBeNull();
    expect(rotated!.refresh).not.toBe(first.refresh);
    // the consumed token is gone
    expect(await rotateSession(db, nodeCrypto, secret, first.refresh)).toBeNull();

    await dropSession(db, nodeCrypto, rotated!.refresh);
    expect(await rotateSession(db, nodeCrypto, secret, rotated!.refresh)).toBeNull();
  });
});
