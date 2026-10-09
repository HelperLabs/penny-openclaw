export const MCP_URL = "https://app.mypenny.ai/mcp";
export const USER_AGENT = "penny-openclaw/0.1.0";
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type Note = {
  id: string;
  content: string;
  tags: string[];
  score: number;
};
export type Guard = () => void;
export class PennyError extends Error {}
export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function privateNotes(value: unknown, allowUnlabeled = false): Note[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => {
      if (
        !object(item) ||
        typeof item.content !== "string" ||
        !item.content.trim()
      )
        return false;
      if (
        [
          "workspaceId",
          "sharedVia",
          "author",
          "sharedReceipt",
          "sharedProposal",
        ].some((key) => key in item)
      )
        return false;
      return object(item.scope)
        ? item.scope.kind === "private"
        : allowUnlabeled && !("scope" in item);
    })
    .flatMap((item) => {
      const id = item._id ?? item.id;
      const score = item.score ?? item.relevanceScore;
      return typeof id === "string" && id
        ? [
            {
              id,
              content: item.content as string,
              tags: Array.isArray(item.tags)
                ? item.tags.filter((v): v is string => typeof v === "string")
                : [],
              score:
                typeof score === "number" && Number.isFinite(score)
                  ? Math.max(0, Math.min(1, score))
                  : 0,
            },
          ]
        : [];
    });
}

export function confirmedSave(value: unknown): string {
  if (
    !object(value) ||
    Object.keys(value).some((k) => !["ok", "failed", "receipts"].includes(k)) ||
    !Array.isArray(value.ok) ||
    value.ok.length !== 1 ||
    typeof value.ok[0] !== "string" ||
    !value.ok[0].trim() ||
    !Array.isArray(value.failed) ||
    value.failed.length
  )
    throw new PennyError(
      "Penny did not confirm a private save. Search before retrying.",
    );
  const id = value.ok[0];
  const receipts = "receipts" in value ? value.receipts : {};
  if (!object(receipts))
    throw new PennyError("Penny returned an invalid save receipt.");
  if (Object.keys(receipts).length === 0) return id;
  const r = receipts[id];
  if (
    Object.keys(receipts).length !== 1 ||
    !object(r) ||
    Object.keys(r).length !== 2 ||
    r.status !== "saved" ||
    r.memoryId !== id
  )
    throw new PennyError(
      "Penny did not confirm a new private save. Search before retrying.",
    );
  return id;
}

export async function boundedJson(
  response: Response,
  maxBytes = 2 * 1024 * 1024,
  matchingId?: number,
): Promise<unknown> {
  if (!response.body) throw new PennyError("Penny returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0,
    buffer = "";
  const sse = response.headers
    .get("content-type")
    ?.includes("text/event-stream");
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  const parse = (data: string): unknown => {
    try {
      return JSON.parse(data);
    } catch {
      throw new PennyError("Penny returned invalid JSON.");
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes)
        throw new PennyError("Penny response exceeds the memory budget.");
      if (!sse) {
        chunks.push(value);
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        const parsed = parse(data),
          items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (
            matchingId !== undefined &&
            object(item) &&
            item.id === matchingId
          )
            return item;
          events.push(item);
        }
      }
    }
    if (sse) return events;
    return parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class PennyClient {
  private id = 0;
  private ready = false;
  private session: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private token: (signal?: AbortSignal) => Promise<string>,
    private fetcher: Fetcher = fetch,
  ) {}

  call(
    name: string,
    args: Record<string, unknown>,
    guard: Guard = () => {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const operation = this.tail.then(async () => {
      guard();
      signal?.throwIfAborted();
      if (!this.ready) {
        const r = await this.rpc(
          "initialize",
          {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "penny-openclaw", version: "0.1.0" },
          },
          guard,
          signal,
        );
        if (!object(r) || r.protocolVersion !== "2025-03-26")
          throw new PennyError("Penny negotiated an unsupported MCP version.");
        await this.rpc("notifications/initialized", {}, guard, signal, true);
        this.ready = true;
      }
      const r = await this.rpc(
        "tools/call",
        { name, arguments: args },
        guard,
        signal,
      );
      if (!object(r) || r.isError)
        throw new PennyError("Penny rejected the memory request.");
      if ("structuredContent" in r) {
        const s = r.structuredContent;
        return object(s) && "value" in s ? s.value : s;
      }
      if (Array.isArray(r.content))
        for (const b of r.content) {
          if (object(b) && b.type === "text" && typeof b.text === "string") {
            try {
              return JSON.parse(b.text);
            } catch {}
          }
        }
      throw new PennyError("Penny returned an unsupported tool response.");
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    guard: Guard,
    signal?: AbortSignal,
    notification = false,
  ): Promise<unknown> {
    const bearer = await this.token(signal);
    guard();
    signal?.throwIfAborted();
    if (!bearer || bearer.startsWith("mpt_"))
      throw new PennyError("Connect this OpenClaw plugin with Penny OAuth.");
    const id = notification ? undefined : ++this.id;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
      "User-Agent": USER_AGENT,
    };
    if (this.session) headers["Mcp-Session-Id"] = this.session;
    try {
      const response = await this.fetcher(MCP_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          params,
          ...(id === undefined ? {} : { id }),
        }),
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(8000),
          ...(signal ? [signal] : []),
        ]),
      });
      try {
        guard();
        signal?.throwIfAborted();
      } catch (e) {
        await response.body?.cancel().catch(() => {});
        throw e;
      }
      if (!response.ok) {
        if (response.status === 404) {
          this.ready = false;
          this.session = undefined;
        }
        await response.body?.cancel();
        throw new PennyError(
          `Penny request failed (HTTP ${response.status}). Reconnect if authorization failed.`,
        );
      }
      const session = response.headers.get("Mcp-Session-Id");
      if (session && session.length <= 256 && !/[\r\n]/.test(session))
        this.session = session;
      if (notification) {
        await response.body?.cancel();
        return;
      }
      let envelope = await boundedJson(response, 2 * 1024 * 1024, id);
      guard();
      signal?.throwIfAborted();
      if (Array.isArray(envelope))
        envelope = envelope.find((v) => object(v) && v.id === id);
      if (
        !object(envelope) ||
        envelope.jsonrpc !== "2.0" ||
        envelope.id !== id ||
        "error" in envelope ||
        !("result" in envelope)
      )
        throw new PennyError("Penny rejected the MCP request.");
      return envelope.result;
    } catch (error) {
      if (error instanceof PennyError) throw error;
      throw new PennyError("Penny request stopped or could not be reached.");
    }
  }
}
