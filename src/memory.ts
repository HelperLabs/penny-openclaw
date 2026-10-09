import { createHash } from "node:crypto";
import { AuthStore } from "./auth.js";
import {
  PennyClient,
  PennyError,
  object,
  privateNotes,
  confirmedSave,
  type Guard,
  type Note,
} from "./client.js";
import type { Options } from "./policy.js";
import type { MemoryPluginCapability } from "openclaw/plugin-sdk/memory-host-core";

export type NativeRuntime = NonNullable<
  MemoryPluginCapability["providerRuntime"]
>;
export type NativeOpen = Parameters<NativeRuntime["open"]>[0];
type Handle = NonNullable<
  Awaited<ReturnType<NativeRuntime["open"]>>["provider"]
>;

export class Memory {
  private identity: string | null = null;
  private client: PennyClient | undefined;
  private stopped = false;
  private abort = new AbortController();
  // Host tools close a lease after each invocation. Snapshots may outlive that
  // lease only within the same verified owner session incarnation and account.
  private snapshots = new Map<
    string,
    { at: number; notes: Map<string, Pick<Note, "id" | "content">> }
  >();
  constructor(
    readonly auth: AuthStore,
    readonly config: () => Options,
  ) {}
  private currentIdentity() {
    const id = this.auth.identity();
    if (id !== this.identity) {
      this.snapshots.clear();
      this.client = undefined;
      this.identity = id;
    }
    return id;
  }
  guard(identity: string, external: Guard = () => {}): Guard {
    return () => {
      external();
      if (this.stopped || this.currentIdentity() !== identity)
        throw new PennyError(
          "Penny authorization or plugin lifetime changed. Retry with the current account.",
        );
    };
  }
  private connected(external: Guard) {
    external();
    if (this.stopped) throw new PennyError("Penny stopped.");
    const id = this.currentIdentity();
    if (!id) throw new PennyError("Connect Penny with openclaw penny login.");
    if (!this.client) {
      this.client = new PennyClient((signal) => this.auth.token(id, signal));
    }
    return { client: this.client!, guard: this.guard(id, external) };
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    guard: Guard,
    signal?: AbortSignal,
  ) {
    const c = this.connected(guard);
    const result = await c.client.call(
      name,
      args,
      c.guard,
      AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(8000),
        ...(signal ? [signal] : []),
      ]),
    );
    c.guard();
    return result;
  }
  async search(
    query: string,
    limit: number,
    guard: Guard,
    signal?: AbortSignal,
  ): Promise<Note[]> {
    if (
      !query.trim() ||
      query.length > 4000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10
    )
      throw new PennyError(
        "Use a search query up to 4,000 characters and 1–10 results.",
      );
    const value = await this.call(
      "penny_read",
      {
        target: "search",
        query,
        limit,
        scope: "private",
        graphTraversal: false,
      },
      guard,
      signal,
    );
    let allowUnlabeled = false;
    if (
      Array.isArray(value) &&
      value.some((v) => object(v) && !("scope" in v))
    ) {
      const scopes = await this.call(
        "penny_read",
        { target: "projects", view: "scopes", limit: 1 },
        guard,
        signal,
      );
      allowUnlabeled =
        object(scopes) &&
        Array.isArray(scopes.scopes) &&
        scopes.scopes.length === 0 &&
        scopes.coverage === "complete" &&
        scopes.nextCursor === null;
    }
    guard();
    return privateNotes(value, allowUnlabeled).slice(0, limit);
  }
  async profile(guard: Guard, signal?: AbortSignal) {
    const result = await this.call(
      "penny_read",
      { target: "profile", scope: "private" },
      guard,
      signal,
    );
    if (!object(result) || !Array.isArray(result.global))
      throw new PennyError("Penny returned an unsupported private profile.");
    return result.global;
  }
  async remember(
    note: {
      content: string;
      tags: string[];
      confidence: number;
      sampleQuestions: string[];
    },
    guard: Guard,
    signal?: AbortSignal,
  ) {
    // Every write is explicitly private; no Space proposals or shared receipts are accepted.
    const receipt = await this.call(
      "penny_write",
      {
        entityType: "note",
        scope: "private",
        notes: [JSON.stringify({ ...note, source: "openclaw" })],
      },
      guard,
      signal,
    );
    guard();
    return confirmedSave(receipt);
  }
  stop() {
    this.stopped = true;
    this.abort.abort();
    this.client = undefined;
    this.identity = null;
    this.snapshots.clear();
  }

  native(): NativeRuntime {
    const memory = this;
    return {
      async open({ context, agentId }: NativeOpen) {
        context.assertCurrent();
        context.signal?.throwIfAborted();
        const identity = memory.currentIdentity();
        const a = context.authority;
        const cacheKey =
          a.kind === "session"
            ? JSON.stringify([identity, agentId, a.sessionKey, a.sessionId])
            : "";
        let closed = false;
        const lease = new AbortController();
        const currency = () => {
          context.assertCurrent();
          context.signal?.throwIfAborted();
          if (closed || memory.stopped)
            throw new PennyError("Penny memory lease has closed.");
        };
        const authorized = () => {
          currency();
          const c = memory.config(),
            a = context.authority;
          if (
            a.kind !== "session" ||
            a.sessionKey !== c.sessionKey ||
            a.sandboxed !== false ||
            !a.sessionId ||
            a.audience?.kind !== "owner-private" ||
            a.audience.agentId !== c.agentId ||
            agentId !== c.agentId ||
            /:(cron|subagent|incognito):/.test(a.sessionKey)
          )
            throw new PennyError(
              "Penny private reads require the configured owner main session.",
            );
          if (!identity) throw new PennyError("Connect Penny first.");
          memory.guard(identity)();
        };
        const signal = AbortSignal.any([
          lease.signal,
          ...(context.signal ? [context.signal] : []),
        ]);
        const provider: Handle = {
          capabilities: {
            sources: ["memory"],
            pagination: false,
            candidates: [],
            projectFilter: false,
          },
          async search(request) {
            authorized();
            if (
              request.cursor ||
              request.activeProjectKeys?.length ||
              request.sources?.some((s) => s !== "memory")
            )
              throw new PennyError(
                "Penny searches private notes only, without cursors.",
              );
            if (
              request.minScore !== undefined &&
              (!Number.isFinite(request.minScore) ||
                request.minScore < 0 ||
                request.minScore > 1)
            )
              throw new PennyError("Invalid memory score threshold.");
            const notes = await memory.search(
              request.query,
              request.maxResults ?? 5,
              authorized,
              signal,
            );
            authorized();
            const cache = new Map<string, Pick<Note, "id" | "content">>();
            const hits = notes
              .filter((n) => n.score >= (request.minScore ?? 0))
              .map((n) => {
                cache.set(n.id, { id: n.id, content: n.content });
                return {
                  reference: {
                    providerId: "penny",
                    id: n.id,
                    revision: createHash("sha256")
                      .update(n.content)
                      .digest("hex"),
                  },
                  excerpt: n.content,
                  score: n.score,
                  source: "memory",
                  automaticRecall: { eligible: true },
                };
              });
            memory.snapshots.set(cacheKey, { at: Date.now(), notes: cache });
            let bytes = 0;
            for (const [key, snapshot] of [...memory.snapshots].reverse()) {
              bytes += [...snapshot.notes.values()].reduce(
                (n, note) =>
                  n +
                  Buffer.byteLength(JSON.stringify(note)) +
                  Buffer.byteLength(note.id),
                0,
              );
              if (
                bytes > 2 * 1024 * 1024 ||
                Date.now() - snapshot.at > 10 * 60 * 1000
              )
                memory.snapshots.delete(key);
            }
            while (memory.snapshots.size > 8)
              memory.snapshots.delete(memory.snapshots.keys().next().value!);
            return { hits, coverage: "partial" as const };
          },
          async get({ reference, from = 1, lines = 1000 }) {
            authorized();
            if (
              reference.providerId !== "penny" ||
              reference.fragment ||
              !Number.isInteger(from) ||
              from < 1 ||
              !Number.isInteger(lines) ||
              lines < 1 ||
              lines > 1000
            )
              throw new PennyError(
                "Invalid Penny memory reference or line range.",
              );
            const snapshot = memory.snapshots.get(cacheKey);
            if (snapshot && Date.now() - snapshot.at > 10 * 60 * 1000) {
              memory.snapshots.delete(cacheKey);
              return { status: "not_found" };
            }
            const n = snapshot?.notes.get(reference.id);
            if (!n) return { status: "not_found" };
            const revision = createHash("sha256")
              .update(n.content)
              .digest("hex");
            if (reference.revision && reference.revision !== revision)
              return { status: "not_found" };
            const all = n.content.split("\n"),
              selected = all.slice(from - 1, from - 1 + lines);
            authorized();
            return {
              status: "ok",
              reference: { providerId: "penny", id: n.id, revision },
              text: selected.join("\n"),
              from,
              lines: selected.length,
              truncated: from - 1 + selected.length < all.length,
            };
          },
          async health() {
            currency();
            return {
              status: memory.auth.identity() ? "ready" : "unavailable",
              message: memory.auth.identity()
                ? "OAuth credentials present; connectivity is checked on use."
                : "Connect with openclaw penny login.",
            };
          },
          async close() {
            closed = true;
            lease.abort();
          },
        };
        return { provider };
      },
    };
  }
}
