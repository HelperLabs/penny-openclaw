import * as fs from "node:fs";
import * as path from "node:path";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import {
  boundedJson,
  PennyError,
  USER_AGENT,
  object,
  type Fetcher,
} from "./client.js";

export const ISSUER = "https://clerk.mypenny.ai";
export const RESOURCE = "https://app.mypenny.ai/mcp";
const SCOPES = "openid profile email offline_access";
export type Credentials = {
  identity: string;
  clientId: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};
const text = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 65536 &&
  !/[\r\n\0]/.test(value);

export function trustedEndpoint(value: unknown): string {
  if (typeof value !== "string")
    throw new PennyError("Penny authorization metadata is incomplete.");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new PennyError("Penny authorization endpoint is invalid.");
  }
  if (u.origin !== ISSUER || u.username || u.password || u.search || u.hash)
    throw new PennyError(
      "Penny advertised an untrusted authorization endpoint.",
    );
  return u.href;
}
export function validateToken(
  value: unknown,
  previous?: Credentials,
): Pick<Credentials, "accessToken" | "refreshToken" | "expiresAt"> {
  if (
    !object(value) ||
    !text(value.access_token) ||
    value.access_token.startsWith("mpt_") ||
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer" ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0
  )
    throw new PennyError("Penny returned an invalid OAuth token response.");
  const refreshToken = value.refresh_token ?? previous?.refreshToken;
  if (refreshToken !== undefined && !text(refreshToken))
    throw new PennyError("Penny returned an invalid refresh token.");
  if (
    value.scope !== undefined &&
    (typeof value.scope !== "string" ||
      value.scope.split(/\s+/).some((s) => !SCOPES.split(" ").includes(s)))
  )
    throw new PennyError("Penny returned unexpected authorization scopes.");
  return {
    accessToken: value.access_token,
    refreshToken: refreshToken as string | undefined,
    expiresAt: Date.now() + value.expires_in * 1000,
  };
}
export function validateCallback(url: URL, state: string): string {
  const supplied = url.searchParams.get("state");
  if (
    !supplied ||
    Buffer.byteLength(supplied) !== Buffer.byteLength(state) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(state)) ||
    url.searchParams.get("iss") !== ISSUER ||
    url.searchParams.has("error") ||
    !text(url.searchParams.get("code")) ||
    ["state", "iss", "code"].some(
      (k) => url.searchParams.getAll(k).length !== 1,
    )
  )
    throw new PennyError(
      "Penny OAuth callback failed its state or issuer check.",
    );
  return url.searchParams.get("code")!;
}
async function requestJson(
  url: string,
  init: RequestInit = {},
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  try {
    const response = await fetcher(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...init.headers,
      },
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(10000),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PennyError(
        `Penny authorization request failed (HTTP ${response.status}).`,
      );
    }
    return await boundedJson(response, 262144);
  } catch (e) {
    if (e instanceof PennyError) throw e;
    throw new PennyError("Penny authorization could not be reached.");
  }
}
async function tokenRequest(
  endpoint: string,
  fields: Record<string, string>,
  fetcher?: Fetcher,
  signal?: AbortSignal,
) {
  return requestJson(
    trustedEndpoint(endpoint),
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal,
    },
    fetcher,
  );
}

export class AuthStore {
  readonly directory: string;
  readonly file: string;
  private directoryIdentity: string | undefined;
  constructor(
    directory: string,
    private fetcher: Fetcher = fetch,
  ) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, "auth.json");
  }
  private checkAncestors() {
    let current = path.dirname(this.directory);
    while (true) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          current = path.dirname(current);
          continue;
        }
        throw new PennyError("Penny credential ancestry could not be checked.");
      }
      // macOS /var and /tmp are root-managed aliases. User-controlled aliases are rejected.
      if (stat.isSymbolicLink()) {
        if (stat.uid !== 0)
          throw new PennyError(
            "Penny credential ancestry contains an unsafe symlink.",
          );
        stat = fs.statSync(current);
      }
      const uid = process.getuid?.();
      if (
        !stat.isDirectory() ||
        (uid !== undefined && stat.uid !== uid && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && stat.mode & 0o1000))
      )
        throw new PennyError(
          "Penny credential ancestry is writable by another user.",
        );
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  private checkDirectory(create = false): boolean {
    this.checkAncestors();
    if (create) fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let info: fs.Stats;
    try {
      info = fs.lstatSync(this.directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new PennyError("Penny credential directory could not be read.");
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new PennyError(
        "Penny credential directory has unsafe ownership or permissions.",
      );
    const identity = `${info.dev}:${info.ino}`;
    if (this.directoryIdentity && identity !== this.directoryIdentity)
      throw new PennyError("Penny credential directory changed during use.");
    this.directoryIdentity = identity;
    return true;
  }
  preflight() {
    this.load();
  }
  load(): Credentials | null {
    if (!this.checkDirectory()) return null;
    let fd: number;
    try {
      fd = fs.openSync(
        this.file,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          fs.lstatSync(this.file);
        } catch (x) {
          if ((x as NodeJS.ErrnoException).code === "ENOENT") return null;
        }
      }
      throw new PennyError("Penny credentials could not be opened safely.");
    }
    try {
      this.checkDirectory();
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 262144 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new PennyError(
          "Penny credentials have unsafe ownership or permissions.",
        );
      let r: unknown;
      try {
        r = JSON.parse(fs.readFileSync(fd, "utf8"));
      } catch {
        throw new PennyError(
          "Penny credentials are invalid. Reconnect this plugin.",
        );
      }
      if (
        !object(r) ||
        !text(r.identity) ||
        !text(r.clientId) ||
        !text(r.accessToken) ||
        r.accessToken.startsWith("mpt_") ||
        typeof r.expiresAt !== "number" ||
        !Number.isFinite(r.expiresAt) ||
        (r.refreshToken !== undefined && !text(r.refreshToken))
      )
        throw new PennyError(
          "Penny credentials are invalid. Reconnect this plugin.",
        );
      trustedEndpoint(r.tokenEndpoint);
      return r as Credentials;
    } finally {
      fs.closeSync(fd);
    }
  }
  identity(): string | null {
    return this.load()?.identity ?? null;
  }
  private lock(): () => void {
    this.checkDirectory(true);
    const lock = path.join(this.directory, ".auth-lock");
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw new PennyError(
          "Penny credential storage is busy. Retry after the other login or refresh finishes.",
        );
      throw new PennyError("Penny credential lock could not be created.");
    }
    try {
      fs.writeFileSync(
        path.join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid }),
        { mode: 0o600, flag: "wx" },
      );
    } catch (e) {
      fs.rmSync(lock, { recursive: true });
      throw e;
    }
    return () => {
      this.checkDirectory();
      fs.rmSync(lock, { recursive: true });
    };
  }
  private saveUnlocked(
    record: Credentials,
    expectedIdentity?: string | null,
    sync: (fd: number) => void = fs.fsyncSync,
  ) {
    this.checkDirectory(true);
    if (expectedIdentity !== undefined && this.identity() !== expectedIdentity)
      throw new PennyError(
        "Penny authorization changed. Retry with the current account.",
      );
    const tmp = path.join(this.directory, `.auth-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        tmp,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      fs.writeFileSync(fd, JSON.stringify(record));
      sync(fd);
      fs.fchmodSync(fd, 0o600);
      fs.closeSync(fd);
      fd = undefined;
      this.checkDirectory();
      if (
        expectedIdentity !== undefined &&
        this.identity() !== expectedIdentity
      )
        throw new PennyError("Penny authorization changed.");
      fs.renameSync(tmp, this.file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  }
  save(
    record: Credentials,
    expectedIdentity?: string | null,
    sync: (fd: number) => void = fs.fsyncSync,
  ) {
    const release = this.lock();
    try {
      this.saveUnlocked(record, expectedIdentity, sync);
    } finally {
      release();
    }
  }
  async token(expectedIdentity: string, signal?: AbortSignal): Promise<string> {
    const before = this.load();
    if (!before || before.identity !== expectedIdentity)
      throw new PennyError("Connect Penny for this OpenClaw profile.");
    if (before.expiresAt > Date.now() + 30000) return before.accessToken;
    const until = Date.now() + 10000;
    let release: (() => void) | undefined;
    while (!release) {
      signal?.throwIfAborted();
      try {
        release = this.lock();
      } catch (e) {
        if (
          !(e instanceof PennyError) ||
          !e.message.includes("storage is busy") ||
          Date.now() >= until
        )
          throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      const r = this.load();
      if (!r || r.identity !== expectedIdentity)
        throw new PennyError("Penny authorization changed.");
      if (r.expiresAt > Date.now() + 30000) return r.accessToken;
      if (!r.refreshToken)
        throw new PennyError("Penny login expired. Reconnect this plugin.");
      const value = await tokenRequest(
        r.tokenEndpoint,
        {
          grant_type: "refresh_token",
          refresh_token: r.refreshToken,
          client_id: r.clientId,
        },
        this.fetcher,
        signal,
      );
      signal?.throwIfAborted();
      const next = { ...r, ...validateToken(value, r) };
      this.saveUnlocked(next, expectedIdentity);
      return next.accessToken;
    } finally {
      release();
    }
  }
  logout() {
    if (!this.checkDirectory()) return;
    const release = this.lock();
    try {
      if (this.load()) fs.unlinkSync(this.file);
    } finally {
      release();
    }
  }
}

export async function login(
  store: AuthStore,
  showUrl: (url: string) => void,
  fetcher: Fetcher = fetch,
): Promise<void> {
  store.preflight();
  const expectedIdentity = store.identity();
  const signal = AbortSignal.timeout(180000);
  const protectedResource = await requestJson(
    "https://app.mypenny.ai/.well-known/oauth-protected-resource",
    { signal },
    fetcher,
  );
  if (
    !object(protectedResource) ||
    protectedResource.resource !== RESOURCE ||
    !Array.isArray(protectedResource.authorization_servers) ||
    !protectedResource.authorization_servers.includes(ISSUER)
  )
    throw new PennyError("Penny advertised an unexpected OAuth resource.");
  const metadata = await requestJson(
    `${ISSUER}/.well-known/oauth-authorization-server`,
    { signal },
    fetcher,
  );
  if (
    !object(metadata) ||
    metadata.issuer !== ISSUER ||
    !Array.isArray(metadata.code_challenge_methods_supported) ||
    !metadata.code_challenge_methods_supported.includes("S256") ||
    !Array.isArray(metadata.token_endpoint_auth_methods_supported) ||
    !metadata.token_endpoint_auth_methods_supported.includes("none")
  )
    throw new PennyError("Penny OAuth metadata does not support secure PKCE.");
  const authorizationEndpoint = trustedEndpoint(
      metadata.authorization_endpoint,
    ),
    tokenEndpoint = trustedEndpoint(metadata.token_endpoint),
    registrationEndpoint = trustedEndpoint(metadata.registration_endpoint);
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(48).toString("base64url");
  let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Attach a handler immediately; a registration error must not leave an unhandled rejection.
  void code.catch(() => {});
  const server = createServer((req, res) => {
    try {
      if (
        req.method !== "GET" ||
        !req.url ||
        req.headers.host !==
          `127.0.0.1:${(server.address() as { port: number }).port}`
      )
        throw new PennyError("Unexpected OAuth callback.");
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback")
        throw new PennyError("Unexpected OAuth callback.");
      if (
        u.searchParams.get("state") === state &&
        u.searchParams.get("iss") === ISSUER &&
        u.searchParams.has("error")
      )
        rejectCode(new PennyError("Penny authorization was declined."));
      const authCode = validateCallback(u, state);
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      res.end(
        "Authorization received. Return to the terminal to confirm the connection.",
      );
      resolveCode(authCode);
    } catch {
      res.writeHead(400, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      res.end("OAuth callback rejected. Return to the login command.");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
  const onAbort = () =>
    rejectCode(new PennyError("Penny login timed out. Run login again."));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const registration = await requestJson(
      registrationEndpoint,
      {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Penny for OpenClaw",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: SCOPES,
        }),
      },
      fetcher,
    );
    if (
      !object(registration) ||
      !text(registration.client_id) ||
      ("client_secret" in registration && registration.client_secret) ||
      registration.token_endpoint_auth_method !== "none"
    )
      throw new PennyError("Penny did not register a public OAuth client.");
    const clientId = registration.client_id;
    const url = new URL(authorizationEndpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: SCOPES,
      resource: RESOURCE,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }))
      url.searchParams.set(key, value);
    showUrl(url.href);
    const authCode = await code;
    const token = await tokenRequest(
      tokenEndpoint,
      {
        grant_type: "authorization_code",
        code: authCode,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      },
      fetcher,
      signal,
    );
    signal.throwIfAborted();
    store.save(
      {
        identity: randomUUID(),
        clientId,
        tokenEndpoint,
        ...validateToken(token),
      },
      expectedIdentity,
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
