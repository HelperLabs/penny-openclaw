import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  AuthStore,
  trustedEndpoint,
  validateToken,
  validateCallback,
  login,
  ISSUER,
  RESOURCE,
} from "../src/auth.ts";

test("OAuth pins issuer endpoints and rejects credential redirects and incomplete tokens", () => {
  assert.equal(
    trustedEndpoint("https://clerk.mypenny.ai/oauth/token"),
    "https://clerk.mypenny.ai/oauth/token",
  );
  for (const url of [
    "http://clerk.mypenny.ai/token",
    "https://evil.test/token",
    "https://clerk.mypenny.ai@evil.test/token",
    "https://clerk.mypenny.ai/token?key=x",
  ])
    assert.throws(() => trustedEndpoint(url));
  assert.throws(() =>
    validateToken({
      access_token: "mpt_bad",
      token_type: "bearer",
      expires_in: 3600,
    }),
  );
  assert.throws(() =>
    validateToken({
      access_token: "token",
      token_type: "bearer",
      expires_in: 0,
    }),
  );
});

test("complete public-client OAuth flow binds PKCE, loopback, resource and a separate store", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "penny-claw-login-"));
  const store = new AuthStore(path.join(home, "penny"));
  let registration: Record<string, unknown> | undefined,
    authorization: URL | undefined,
    callback: Promise<Response> | undefined;
  const fetcher = async (url: string, init: RequestInit) => {
    assert.equal(init.redirect, "error");
    if (url.includes("oauth-protected-resource"))
      return Response.json({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
      });
    if (url.includes("oauth-authorization-server"))
      return Response.json({
        issuer: ISSUER,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
      });
    if (url.endsWith("/register")) {
      registration = JSON.parse(String(init.body));
      return Response.json({
        client_id: "public-client",
        token_endpoint_auth_method: "none",
      });
    }
    assert.equal(url, `${ISSUER}/token`);
    const fields = new URLSearchParams(String(init.body));
    assert.equal(fields.get("code"), "one-use");
    assert.equal(fields.get("client_id"), "public-client");
    assert.equal(
      fields.get("redirect_uri"),
      authorization!.searchParams.get("redirect_uri"),
    );
    const { createHash } = await import("node:crypto");
    assert.equal(
      createHash("sha256")
        .update(fields.get("code_verifier")!)
        .digest("base64url"),
      authorization!.searchParams.get("code_challenge"),
    );
    return Response.json({
      access_token: "own-oauth-token",
      refresh_token: "own-refresh",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid profile email offline_access",
    });
  };
  try {
    await login(
      store,
      (url) => {
        authorization = new URL(url);
        assert.equal(authorization.origin, ISSUER);
        assert.equal(authorization.searchParams.get("resource"), RESOURCE);
        const redirect = new URL(
          authorization.searchParams.get("redirect_uri")!,
        );
        assert.equal(redirect.hostname, "127.0.0.1");
        redirect.search = new URLSearchParams({
          state: authorization.searchParams.get("state")!,
          iss: ISSUER,
          code: "one-use",
        }).toString();
        callback = fetch(redirect);
      },
      fetcher,
    );
    assert.equal((await callback!).status, 200);
    assert.equal(registration!.token_endpoint_auth_method, "none");
    assert.equal(store.load()!.accessToken, "own-oauth-token");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("login rejects unsafe existing storage before any discovery or registration", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "penny-claw-unsafe-"));
  const dir = path.join(home, "penny");
  fs.mkdirSync(dir, { mode: 0o755 });
  let calls = 0;
  try {
    await assert.rejects(() =>
      login(
        new AuthStore(dir),
        () => {},
        async () => {
          calls++;
          return Response.json({});
        },
      ),
    );
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("independent stores serialize refresh and refuse logout or replacement while refresh owns the lock", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "penny-claw-race-"));
  let release!: () => void,
    started!: () => void,
    calls = 0;
  const pending = new Promise<void>((r) => (release = r)),
    begun = new Promise<void>((r) => (started = r));
  const fetcher = async () => {
    calls++;
    started();
    await pending;
    return Response.json({
      access_token: "rotated",
      refresh_token: "new-refresh",
      token_type: "bearer",
      expires_in: 3600,
    });
  };
  try {
    const a = new AuthStore(path.join(home, "penny"), fetcher),
      b = new AuthStore(a.directory, fetcher);
    const record = {
      identity: "a",
      clientId: "client",
      tokenEndpoint: "https://clerk.mypenny.ai/oauth/token",
      accessToken: "expired",
      refreshToken: "old-refresh",
      expiresAt: 0,
    };
    a.save(record);
    const first = a.token("a");
    await begun;
    const second = b.token("a");
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {AuthStore} from './src/auth.ts';try{new AuthStore(process.env.PENNY_TEST_STORE).logout();process.exit(2);}catch(e){process.exit(e.message.includes('storage is busy')?0:3);}`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PENNY_TEST_STORE: a.directory },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.throws(() => b.logout());
    assert.throws(() => b.save({ ...record, identity: "b" }));
    release();
    assert.deepEqual(await Promise.all([first, second]), [
      "rotated",
      "rotated",
    ]);
    assert.equal(calls, 1);
    b.logout();
    assert.equal(a.identity(), null);
    assert.throws(() => a.save(record, "a"));
    b.logout();
  } finally {
    release();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("storage refuses user-controlled ancestor aliases, writable ancestry and directory replacement", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "penny-claw-ancestry-"));
  try {
    const safe = path.join(home, "safe");
    fs.mkdirSync(safe, { mode: 0o700 });
    const alias = path.join(home, "alias");
    fs.symlinkSync(safe, alias);
    assert.throws(() => new AuthStore(path.join(alias, "penny")).preflight());
    fs.chmodSync(safe, 0o777);
    assert.throws(() => new AuthStore(path.join(safe, "penny")).preflight());
    fs.chmodSync(safe, 0o700);
    const store = new AuthStore(path.join(safe, "penny"));
    store.save({
      identity: "a",
      clientId: "c",
      tokenEndpoint: `${ISSUER}/token`,
      accessToken: "token",
      expiresAt: 1,
    });
    fs.renameSync(store.directory, path.join(safe, "old"));
    fs.mkdirSync(store.directory, { mode: 0o700 });
    assert.throws(() => store.load());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("failed fsync removes credential-bearing temporary files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "penny-claw-write-"));
  const store = new AuthStore(path.join(home, "penny"));
  // A write failure is injected at the fsync boundary through the store's narrow test seam.
  try {
    assert.throws(() =>
      store.save(
        {
          identity: "a",
          clientId: "c",
          tokenEndpoint: "https://clerk.mypenny.ai/token",
          accessToken: "token",
          expiresAt: 1,
        },
        undefined,
        () => {
          throw new Error("disk failure");
        },
      ),
    );
    assert.deepEqual(fs.readdirSync(store.directory), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("OAuth callback binds state and issuer and refuses errors", () => {
  const good = new URL(
    "http://127.0.0.1/callback?state=expected&iss=https%3A%2F%2Fclerk.mypenny.ai&code=one-use",
  );
  assert.equal(validateCallback(good, "expected"), "one-use");
  good.searchParams.set("state", "wrong");
  assert.throws(() => validateCallback(good, "expected"));
  good.searchParams.set("state", "expected");
  good.searchParams.set("iss", "https://evil.test");
  assert.throws(() => validateCallback(good, "expected"));
});
test("credential store is independent, private, and rejects symlinks and permissive modes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "penny-claw-auth-"));
  try {
    const store = new AuthStore(path.join(home, "penny"));
    assert.equal(store.identity(), null);
    store.save({
      identity: "account-a",
      clientId: "client",
      tokenEndpoint: "https://clerk.mypenny.ai/oauth/token",
      accessToken: "oauth-token",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60000,
    });
    assert.equal(store.identity(), "account-a");
    assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
    fs.chmodSync(store.file, 0o644);
    assert.throws(() => store.load());
    fs.unlinkSync(store.file);
    fs.symlinkSync(path.join(home, "elsewhere"), store.file);
    assert.throws(() => store.load());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
