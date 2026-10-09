import test from "node:test";
import assert from "node:assert/strict";
import { PennyClient, privateNotes, confirmedSave } from "../src/client.ts";

test("private recall excludes Spaces, unlabeled data, and malformed notes", () => {
  assert.deepEqual(
    privateNotes([
      { _id: "one", content: "private", scope: { kind: "private" } },
      { _id: "two", content: "space", scope: { kind: "workspace" } },
      { _id: "three", content: "unknown" },
      {
        _id: "four",
        content: "ambiguous",
        scope: { kind: "private" },
        workspaceId: "shared",
      },
      { content: 42, scope: { kind: "private" } },
    ]),
    [{ id: "one", content: "private", tags: [], score: 0 }],
  );
});

test("a save must have a matching private saved receipt", () => {
  assert.equal(
    confirmedSave({
      ok: ["one"],
      failed: [],
      receipts: { one: { status: "saved", memoryId: "one" } },
    }),
    "one",
  );
  for (const receipt of [
    {
      ok: ["one"],
      failed: [],
      receipts: { one: { status: "saved", memoryId: "other" } },
    },
    {
      ok: ["one"],
      failed: [],
      receipts: { one: { status: "pending_share_approval", memoryId: "one" } },
    },
    {
      ok: ["one"],
      failed: [],
      receipts: {
        one: { status: "saved", memoryId: "one", sharedReceipt: {} },
      },
    },
    {
      ok: ["one"],
      failed: [],
      receipts: { one: { status: "deduped", memoryId: "one" } },
    },
    { ok: ["one"], failed: ["other"] },
    { ok: ["one"], failed: [], sharedProposal: {} },
    { ok: ["one"], failed: [], receipts: null },
  ])
    assert.throws(() => confirmedSave(receipt));
});

test("MCP returns a matching chunked SSE batch before the stream closes", async () => {
  let cancelled = 0;
  const client = new PennyClient(
    async () => "token",
    async (_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : { structuredContent: { value: { answer: 42 } } };
      const data = `: keepalive\r\ndata: ${JSON.stringify([
        { jsonrpc: "2.0", method: "notifications/progress" },
        { jsonrpc: "2.0", id: body.id, result },
      ])}\r\n\r\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(data.slice(0, 30)));
            controller.enqueue(new TextEncoder().encode(data.slice(30)));
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  );
  assert.deepEqual(
    await client.call("penny_read", {}, () => {}, AbortSignal.timeout(1000)),
    { answer: 42 },
  );
  assert.equal(cancelled, 2);
});

test("an expired MCP session reinitializes next call without replaying a write", async () => {
  let initializations = 0,
    tools = 0;
  const client = new PennyClient(
    async () => "token",
    async (_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (body.method === "initialize") {
        initializations++;
        assert.equal(new Headers(init.headers).get("Mcp-Session-Id"), null);
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-03-26" },
          },
          { headers: { "Mcp-Session-Id": `session-${initializations}` } },
        );
      }
      if (++tools === 1) return new Response("expired", { status: 404 });
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { structuredContent: { value: "ok" } },
      });
    },
  );
  await assert.rejects(() => client.call("penny_write", {}));
  assert.equal(tools, 1);
  assert.equal(await client.call("penny_read", {}), "ok");
  assert.equal(initializations, 2);
});

test("transport uses the pinned origin, cannot redirect credentials, and initializes MCP", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = JSON.parse(String(init.body));
    if (body.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-03-26" }
        : { structuredContent: { value: { ok: true } } };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
  const client = new PennyClient(async () => "test-access-token", fetcher);
  assert.deepEqual(
    await client.call("penny_read", { target: "profile", scope: "private" }),
    { ok: true },
  );
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, "https://app.mypenny.ai/mcp");
    assert.equal(call.init.redirect, "error");
    assert.ok(call.init.signal);
    assert.equal(
      new Headers(call.init.headers).get("User-Agent"),
      "penny-openclaw/0.1.0",
    );
  }
});

test("server errors never expose bodies or credentials", async () => {
  const client = new PennyClient(
    async () => "secret-token",
    async () =>
      new Response("private-server-body secret-token", { status: 401 }),
  );
  await assert.rejects(
    () => client.call("penny_read", {}),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(
        !error.message.includes("private-server-body") &&
          !error.message.includes("secret-token"),
      );
      return true;
    },
  );
});
