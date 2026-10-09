import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AuthStore, type Credentials } from "../src/auth.ts";
import { Memory, type NativeOpen } from "../src/memory.ts";
import { DEFAULTS, type Options } from "../src/policy.ts";

type ToolCall = { name: string; arguments: Record<string, unknown> };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const note = (id: string, content: string, score = 0.9) => ({
  _id: id,
  content,
  score,
  tags: ["synthetic-test"],
  scope: { kind: "private" },
});
const credentials = (identity = "synthetic-account-a"): Credentials => ({
  identity,
  clientId: `synthetic-client-${identity}`,
  tokenEndpoint: "https://clerk.mypenny.ai/oauth/token",
  accessToken: `synthetic-access-${identity}`,
  expiresAt: Date.now() + 3_600_000,
});

function transport(
  t: TestContext,
  tool: (call: ToolCall) => unknown | Promise<unknown>,
) {
  const calls: ToolCall[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(
        String(url),
        "https://app.mypenny.ai/mcp",
        "test transport refuses every other network endpoint",
      );
      assert.equal(init?.redirect, "error");
      const rpc = JSON.parse(String(init?.body));
      if (rpc.method === "notifications/initialized")
        return new Response(null, { status: 204 });
      let result: unknown;
      if (rpc.method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          capabilities: {},
          serverInfo: { name: "synthetic-penny", version: "1" },
        };
      else {
        assert.equal(rpc.method, "tools/call");
        calls.push(rpc.params);
        result = { structuredContent: { value: await tool(rpc.params) } };
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    },
  );
  return calls;
}

function fixture(
  t: TestContext,
  tool: (call: ToolCall) => unknown | Promise<unknown>,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "penny-native-host-"));
  const auth = new AuthStore(path.join(home, "penny"));
  auth.save(credentials());
  const calls = transport(t, tool);
  let config: Options = { ...DEFAULTS };
  const memory = new Memory(auth, () => config);
  t.after(() => {
    memory.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    auth,
    memory,
    calls,
    setConfig(value: Options) {
      config = value;
    },
  };
}

function owner(patch: Record<string, unknown> = {}): NativeOpen {
  return {
    cfg: {},
    agentId: "main",
    purpose: "default",
    context: {
      assertCurrent() {},
      authority: {
        kind: "session",
        sessionKey: DEFAULTS.sessionKey,
        sessionId: "synthetic-main-session",
        sandboxed: false,
        audience: { kind: "owner-private", agentId: "main" },
      },
    },
    ...patch,
  } as NativeOpen;
}

test("native provider searches only private notes, enforces score thresholds, and retrieves exact scoped revisions", async (t) => {
  const f = fixture(t, (call) => {
    assert.equal(call.name, "penny_read");
    assert.deepEqual(call.arguments, {
      target: "search",
      query: "synthetic decision",
      limit: 3,
      scope: "private",
      graphTraversal: false,
    });
    return [
      note(
        "high",
        "First synthetic line\nSecond synthetic line\nThird synthetic line",
        0.92,
      ),
      note("low", "Low score synthetic note", 0.2),
      {
        ...note("shared", "Shared note must never escape", 0.99),
        scope: { kind: "space" },
      },
    ];
  });
  const { provider } = await f.memory.native().open(owner());
  assert.ok(provider);
  assert.deepEqual(provider.capabilities, {
    sources: ["memory"],
    pagination: false,
    candidates: [],
    projectFilter: false,
  });
  const page = await provider.search({
    query: "synthetic decision",
    maxResults: 3,
    minScore: 0.8,
  });
  assert.deepEqual(
    page.hits.map((hit) => hit.reference.id),
    ["high"],
  );
  assert.equal(page.hits[0].reference.providerId, "penny");
  assert.equal(page.coverage, "partial");
  const ref = page.hits[0].reference;
  const excerpt = await provider.get({ reference: ref, from: 2, lines: 1 });
  assert.equal(excerpt.status, "ok");
  if (excerpt.status === "ok") {
    assert.equal(excerpt.text, "Second synthetic line");
    assert.equal(excerpt.truncated, true);
  }
  assert.deepEqual(
    await provider.get({
      reference: { ...ref, revision: "obsolete-revision" },
    }),
    { status: "not_found" },
  );
  assert.deepEqual(
    await provider.get({
      reference: { providerId: "penny", id: "never-returned" },
    }),
    { status: "not_found" },
  );
  await assert.rejects(
    provider.get({ reference: { ...ref, providerId: "another-provider" } }),
  );
  await assert.rejects(provider.get({ reference: ref, from: 0 }));
  await assert.rejects(provider.get({ reference: ref, lines: 1001 }));
  await provider.close();
  const { provider: secondCaller } = await f.memory.native().open(owner());
  assert.ok(secondCaller);
  assert.equal(
    (await secondCaller.get({ reference: ref })).status,
    "ok",
    "host tools reopen leases between search and get",
  );
  await secondCaller.close();
  const changed = owner();
  if (changed.context.authority.kind === "session")
    changed.context.authority.sessionId = "new-incarnation";
  const { provider: anotherSession } = await f.memory.native().open(changed);
  assert.ok(anotherSession);
  assert.deepEqual(
    await anotherSession.get({ reference: ref }),
    { status: "not_found" },
    "references do not transfer snapshots between session incarnations",
  );
  await anotherSession.close();
  await assert.rejects(provider.get({ reference: ref }));
  await assert.rejects(provider.search({ query: "synthetic decision" }));
  assert.equal(
    f.calls.length,
    1,
    "retrieval is bounded to this lease’s returned references",
  );
});

test("native provider denies shared, delegated, sandboxed, missing-authority, and status-only reads before network I/O", async (t) => {
  const f = fixture(t, () => {
    throw new Error("unauthorized network access");
  });
  const good = owner();
  const session = good.context.authority;
  const cases: Array<[string, NativeOpen]> = [
    [
      "shared conversation",
      owner({
        context: {
          assertCurrent() {},
          authority: {
            ...session,
            audience: {
              kind: "conversation",
              agentId: "main",
              sessionKey: DEFAULTS.sessionKey,
              sessionId: "synthetic-main-session",
            },
          },
        },
      }),
    ],
    [
      "cron",
      owner({
        context: {
          assertCurrent() {},
          authority: {
            ...session,
            sessionKey: "agent:main:cron:synthetic-job",
          },
        },
      }),
    ],
    [
      "subagent",
      owner({
        context: {
          assertCurrent() {},
          authority: {
            ...session,
            sessionKey: "agent:main:subagent:synthetic-child",
          },
        },
      }),
    ],
    [
      "incognito",
      owner({
        context: {
          assertCurrent() {},
          authority: {
            ...session,
            sessionKey: "agent:main:incognito:synthetic-session",
          },
        },
      }),
    ],
    [
      "sandbox",
      owner({
        context: {
          assertCurrent() {},
          authority: { ...session, sandboxed: true },
        },
      }),
    ],
    [
      "unknown sandbox state",
      owner({
        context: {
          assertCurrent() {},
          authority: { ...session, sandboxed: undefined },
        },
      }),
    ],
    [
      "missing session incarnation",
      owner({
        context: {
          assertCurrent() {},
          authority: { ...session, sessionId: undefined },
        },
      }),
    ],
    ["other agent", owner({ agentId: "another-agent" })],
    [
      "missing audience",
      owner({
        context: {
          assertCurrent() {},
          authority: { ...session, audience: undefined },
        },
      }),
    ],
    [
      "operator",
      owner({
        purpose: "cli",
        context: {
          assertCurrent() {},
          authority: { kind: "operator", scopes: ["operator.read"] },
        },
      }),
    ],
    [
      "host status",
      owner({
        purpose: "status",
        context: {
          assertCurrent() {},
          authority: { kind: "host", operation: "status" },
        },
      }),
    ],
  ];
  for (const [label, input] of cases)
    await t.test(label, async () => {
      const { provider } = await f.memory.native().open(input);
      assert.ok(
        provider,
        "authenticated callers can receive content-free readiness",
      );
      assert.equal((await provider.health()).status, "ready");
      await assert.rejects(
        provider.search({ query: "synthetic private note" }),
      );
      await assert.rejects(
        provider.get({
          reference: { providerId: "penny", id: "guessed-private-id" },
        }),
      );
      await provider.close();
    });
  assert.equal(f.calls.length, 0);
});

test("native provider rejects unsupported capabilities and invalid bounds without issuing a request", async (t) => {
  const f = fixture(t, () => {
    throw new Error("unexpected request");
  });
  const { provider } = await f.memory.native().open(owner());
  assert.ok(provider);
  for (const request of [
    { query: "synthetic", cursor: "unsupported-cursor" },
    { query: "synthetic", sources: ["sessions"] as ["sessions"] },
    { query: "synthetic", activeProjectKeys: ["unimplemented-project-filter"] },
    { query: "synthetic", minScore: Number.NaN },
    { query: "synthetic", minScore: -1 },
    { query: "synthetic", maxResults: 11 },
  ])
    await assert.rejects(provider.search(request));
  assert.equal(f.calls.length, 0);
  await provider.close();
});

test("native lease rejects stale authority and account changes before reading or returning in-flight memory", async (t) => {
  let current = true;
  const started = deferred();
  const release = deferred();
  const f = fixture(t, async () => {
    started.resolve();
    await release.promise;
    return [note("inflight", "Synthetic prior-account memory")];
  });
  const input = owner();
  input.context.assertCurrent = () => {
    if (!current) throw new Error("synthetic authority retired");
  };
  const { provider } = await f.memory.native().open(input);
  assert.ok(provider);
  const pending = provider.search({ query: "synthetic private memory" });
  await started.promise;
  current = false;
  release.resolve();
  await assert.rejects(pending);
  const before = f.calls.length;
  await assert.rejects(provider.search({ query: "synthetic private memory" }));
  assert.equal(f.calls.length, before);
  await provider.close();

  current = true;
  const { provider: accountLease } = await f.memory.native().open(owner());
  assert.ok(accountLease);
  f.auth.save(credentials("synthetic-account-b"));
  await assert.rejects(
    accountLease.search({ query: "synthetic private memory" }),
  );
  await assert.rejects(
    accountLease.get({ reference: { providerId: "penny", id: "inflight" } }),
  );
  assert.equal(f.calls.length, before);
  await accountLease.close();
});

test("native close discards an in-flight response and never revives a closed lease", async (t) => {
  const started = deferred(),
    release = deferred();
  const f = fixture(t, async () => {
    started.resolve();
    await release.promise;
    return [note("late", "Synthetic late response")];
  });
  const { provider } = await f.memory.native().open(owner());
  assert.ok(provider);
  const pending = provider.search({ query: "synthetic late recall" });
  await started.promise;
  await provider.close();
  release.resolve();
  await assert.rejects(pending);
  await assert.rejects(
    provider.get({ reference: { providerId: "penny", id: "late" } }),
  );
});

test("an account replacement during a native search discards the prior account’s response", async (t) => {
  const started = deferred(),
    release = deferred();
  const f = fixture(t, async () => {
    started.resolve();
    await release.promise;
    return [note("previous-account", "Synthetic account-specific memory")];
  });
  const { provider } = await f.memory.native().open(owner());
  assert.ok(provider);
  const pending = provider.search({ query: "synthetic account recall" });
  await started.promise;
  f.auth.save(credentials("synthetic-account-b"));
  release.resolve();
  await assert.rejects(pending);
  await assert.rejects(
    provider.get({
      reference: { providerId: "penny", id: "previous-account" },
    }),
  );
  assert.equal(
    f.calls.length,
    1,
    "the replacement account is never borrowed to finish an old request",
  );
  await provider.close();
});

test("published beta loader admits the built memory plugin and applies real hook permission and tool-policy gates", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "penny-openclaw-loader-"));
  // Load the shipping files from an immutable fixture: development rebuilds must
  // not race the host's source-integrity check or be mistaken for plugin failures.
  const installedPlugin = path.join(home, "extensions", "penny");
  fs.mkdirSync(path.join(installedPlugin, "dist"), {
    recursive: true,
    mode: 0o700,
  });
  for (const file of [
    "package.json",
    "openclaw.plugin.json",
    "dist/index.js",
  ]) {
    fs.copyFileSync(
      path.join(pluginRoot, file),
      path.join(installedPlugin, file),
    );
  }
  fs.symlinkSync(
    path.join(pluginRoot, "node_modules"),
    path.join(installedPlugin, "node_modules"),
    "dir",
  );
  const keys = [
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.OPENCLAW_STATE_DIR = home;
  process.env.OPENCLAW_CONFIG_PATH = path.join(home, "openclaw.json");
  process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
  const sdkEntry = fileURLToPath(
    import.meta.resolve("openclaw/plugin-sdk/plugin-entry"),
  );
  const hostDist = path.dirname(path.dirname(sdkEntry));
  const version = JSON.parse(
    fs.readFileSync(path.join(hostDist, "..", "package.json"), "utf8"),
  ).version;
  assert.equal(
    version,
    "2026.10.1-beta.2",
    "host contract must use the pinned published beta",
  );
  const auth = new AuthStore(path.join(home, "penny"));
  auth.save(credentials());
  let observeRead: (() => void) | undefined;
  const calls = transport(t, (call) => {
    if (call.name === "penny_read") observeRead?.();
    if (call.name === "penny_read" && call.arguments.target === "profile")
      return {
        global: [{ category: "core", content: "Synthetic owner preference" }],
      };
    if (call.name === "penny_read" && call.arguments.target === "search")
      return [
        note("synthetic-recall", "Synthetic previously recorded decision"),
      ];
    if (call.name === "penny_write")
      return {
        ok: ["synthetic-saved-note"],
        failed: [],
        receipts: {
          "synthetic-saved-note": {
            status: "saved",
            memoryId: "synthetic-saved-note",
          },
        },
      };
    throw new Error("unexpected synthetic host request");
  });
  const cfg = (conversationAccess: boolean, promptInjection = true) => ({
    agents: { defaults: { workspace: path.join(home, "workspace") } },
    plugins: {
      enabled: true,
      allow: ["penny"],
      load: { paths: [installedPlugin] },
      slots: { memory: "penny" },
      entries: {
        penny: {
          enabled: true,
          hooks: {
            allowConversationAccess: conversationAccess,
            allowPromptInjection: promptInjection,
          },
          config: { autoRecall: true, autoCapture: true },
        },
      },
    },
  });
  let runner: any;
  try {
    const loader: any = await import(
      pathToFileURL(path.join(hostDist, "plugins", "loader.js")).href
    );
    const hookHost: any = await import(
      pathToFileURL(path.join(hostDist, "plugins", "hook-runner-global.js"))
        .href
    );
    const load = (config: ReturnType<typeof cfg>) => {
      fs.writeFileSync(
        process.env.OPENCLAW_CONFIG_PATH!,
        JSON.stringify(config),
        { mode: 0o600 },
      );
      return loader.loadPluginRegistryHandle({
        config,
        cache: false,
        workspaceDir: path.join(home, "workspace"),
        throwOnLoadError: true,
      });
    };
    const denied = load(cfg(false));
    assert.equal(
      denied.plugins.find((p: any) => p.id === "penny")?.status,
      "loaded",
    );
    assert.ok(
      !denied.typedHooks.some(
        (h: any) =>
          h.pluginId === "penny" &&
          ["before_prompt_build", "agent_end"].includes(h.hookName),
      ),
      "external conversation hooks require explicit host permission",
    );
    const injectionDenied = load(cfg(true, false));
    assert.ok(
      !injectionDenied.typedHooks.some(
        (h: any) =>
          h.pluginId === "penny" && h.hookName === "before_prompt_build",
      ),
    );
    const registry = load(cfg(true));
    const plugin = registry.plugins.find((p: any) => p.id === "penny");
    assert.equal(plugin?.status, "loaded");
    assert.equal(plugin.memorySlotSelected, true);
    const capability = registry.memoryCapabilities.find(
      (c: any) => c.pluginId === "penny",
    )?.capability;
    assert.ok(capability?.providerRuntime?.open);
    assert.deepEqual(Array.from(capability.recallToolNames), [
      "penny_search",
      "penny_profile",
    ]);
    assert.deepEqual(
      capability.providerFlushPlanResolver().persistenceToolNames,
      ["penny_remember"],
    );
    assert.equal(
      registry.tools.filter((tool: any) => tool.pluginId === "penny").length,
      1,
      "one v2 context-bound factory owns all Penny tools",
    );
    const memoryHost: any = await import(
      pathToFileURL(path.join(hostDist, "plugin-sdk", "memory-host-search.js"))
        .href
    );
    let statusCurrent = true;
    const opened = await memoryHost.getActiveMemoryProvider({
      cfg: cfg(true),
      agentId: "main",
      purpose: "status",
      context: {
        authority: { kind: "host", operation: "status" },
        assertCurrent() {
          if (!statusCurrent)
            throw new Error("synthetic host authority revoked");
        },
      },
    });
    assert.equal(
      opened.adapter,
      "native",
      "published host selects Penny’s neutral runtime rather than a file adapter",
    );
    assert.equal(opened.providerId, "penny");
    assert.ok(opened.provider);
    assert.equal((await opened.provider.health()).status, "ready");
    await assert.rejects(
      opened.provider.search({ query: "synthetic private note" }),
    );
    statusCurrent = false;
    await assert.rejects(opened.provider.health(), /authority revoked/);
    await opened.provider.close();
    assert.equal(
      calls.length,
      0,
      "host status authority grants no private read",
    );
    hookHost.initializeGlobalHookRunner(registry);
    runner = hookHost.getGlobalHookRunner();
    const context = {
      agentId: "main",
      sessionKey: DEFAULTS.sessionKey,
      sessionId: "synthetic-main-session",
      sandboxed: false,
      memoryAudience: { kind: "owner-private", agentId: "main" },
      assertMemoryAudienceCurrent() {},
      inputProvenance: { kind: "external_user" },
      trigger: "user",
    };
    const event = {
      prompt: "Recall the synthetic decision",
      currentUserMessage: "Recall the synthetic decision",
      currentUserMessageId: "synthetic-admission",
      messages: [],
    };
    const dispatch = (ctx: any, tools: string[]) =>
      runner.runAuthorizedPromptBuild(event, ctx, {
        toolAuthorityFingerprint: "synthetic-turn-policy",
        activeToolNames: tools,
        assertHostActive() {},
      });
    assert.equal(
      await runner.runBeforePromptBuild(event, context),
      undefined,
      "authorized recall never runs in the pre-policy phase",
    );
    assert.equal(
      await dispatch(context, ["penny_search"]),
      undefined,
      "partial tool permission does not grant profile access",
    );
    assert.equal(calls.length, 0);
    for (const patch of [
      { sandboxed: true },
      { memoryAudience: { kind: "conversation", agentId: "main" } },
      { trigger: "cron" },
      { sessionKey: "agent:main:subagent:synthetic-child" },
      { assertMemoryAudienceCurrent: undefined },
    ]) {
      assert.equal(
        await dispatch({ ...context, ...patch }, [
          "penny_search",
          "penny_profile",
        ]),
        undefined,
      );
    }
    assert.equal(calls.length, 0);
    const recalled = await dispatch(context, ["penny_search", "penny_profile"]);
    assert.ok(
      recalled?.prependContext?.includes(
        "Synthetic previously recorded decision",
      ),
    );
    assert.equal(calls.filter((call) => call.name === "penny_read").length, 2);
    let audienceCurrent = true;
    observeRead = () => {
      audienceCurrent = false;
    };
    assert.equal(
      await dispatch(
        {
          ...context,
          assertMemoryAudienceCurrent() {
            if (!audienceCurrent) throw new Error("synthetic audience retired");
          },
        },
        ["penny_search", "penny_profile"],
      ),
      undefined,
      "an audience retired during network I/O cannot publish private prompt context",
    );
    observeRead = undefined;
    assert.equal(
      calls.filter((call) => call.name === "penny_read").length,
      3,
      "retirement prevents the following note lookup",
    );

    const captureEvent = {
      success: true,
      messages: [
        {
          role: "user",
          content: "I prefer concise synthetic engineering summaries.",
          provenance: { kind: "external_user" },
        },
      ],
    };
    const beforeWrites = calls.filter(
      (call) => call.name === "penny_write",
    ).length;
    await runner.runAgentEnd(captureEvent, {
      ...context,
      inputProvenance: undefined,
    });
    await runner.runAgentEnd(captureEvent, {
      ...context,
      inputProvenance: { kind: "inter_session" },
    });
    await runner.runAgentEnd({ ...captureEvent, success: false }, context);
    await runner.runBeforeCompaction(
      { messageCount: 1, messages: captureEvent.messages },
      { ...context, inputProvenance: { kind: "internal_system" } },
    );
    assert.equal(
      calls.filter((call) => call.name === "penny_write").length,
      beforeWrites,
      "missing provenance and delegated/failed/maintenance turns never capture",
    );
    await runner.runAgentEnd(captureEvent, context);
    await runner.runAgentEnd(captureEvent, context);
    await runner.runBeforeCompaction(
      { messageCount: 1, messages: captureEvent.messages },
      context,
    );
    assert.equal(
      calls.filter((call) => call.name === "penny_write").length,
      beforeWrites + 1,
      "duplicate end/compaction observations save the selected fact once",
    );
    const saved = calls.find((call) => call.name === "penny_write")!;
    assert.equal(saved.arguments.scope, "private");
    const selected = JSON.parse((saved.arguments.notes as string[])[0]);
    assert.equal(selected.content, captureEvent.messages[0].content);
    assert.equal(selected.sampleQuestions.length, 3);
  } finally {
    if (runner)
      await runner.runGatewayStop({ reason: "synthetic-test-finished" }, {});
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("reopened native snapshots require current authority, expire, and account for oversized references", async (t) => {
  const f = fixture(t, () => [note("snapshot", "Synthetic private snapshot")]);
  const { provider: searcher } = await f.memory.native().open(owner());
  assert.ok(searcher);
  const ref = (await searcher.search({ query: "synthetic snapshot" })).hits[0]
    .reference;
  await searcher.close();
  let current = true;
  const input = owner();
  input.context.assertCurrent = () => {
    if (!current) throw new Error("authority retired");
  };
  const { provider: reader } = await f.memory.native().open(input);
  assert.ok(reader);
  current = false;
  await assert.rejects(reader.get({ reference: ref }));
  await reader.close();
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 10 * 60 * 1000 + 1);
  const { provider: expired } = await f.memory.native().open(owner());
  assert.ok(expired);
  assert.deepEqual(await expired.get({ reference: ref }), {
    status: "not_found",
  });
  await expired.close();
  t.mock.restoreAll();
  const oversized = fixture(t, () => [
    note(
      "x".repeat(1100000),
      "Synthetic bounded note with oversized reference",
    ),
  ]);
  const { provider: large } = await oversized.memory.native().open(owner());
  assert.ok(large);
  const largeRef = (await large.search({ query: "oversized reference" }))
    .hits[0].reference;
  assert.deepEqual(
    await large.get({ reference: largeRef }),
    { status: "not_found" },
    "a retained key and payload exceeding the budget are evicted",
  );
  await large.close();
});
