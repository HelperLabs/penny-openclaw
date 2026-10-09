import { scrubCredentials } from "@mypenny/core/lib/scrub.ts";
import { createHash } from "node:crypto";
import { object, PennyError } from "./client.js";

export type Options = {
  agentId: string;
  sessionKey: string;
  autoRecall: boolean;
  autoCapture: boolean;
  preCompactionSave: boolean;
};
export const DEFAULTS: Options = {
  agentId: "main",
  sessionKey: "agent:main:main",
  autoRecall: true,
  autoCapture: false,
  preCompactionSave: true,
};
export function options(value: unknown): Options {
  const v = object(value) ? value : {};
  return {
    agentId: typeof v.agentId === "string" ? v.agentId : DEFAULTS.agentId,
    sessionKey:
      typeof v.sessionKey === "string" ? v.sessionKey : DEFAULTS.sessionKey,
    autoRecall: v.autoRecall !== false,
    autoCapture: v.autoCapture === true,
    preCompactionSave: v.preCompactionSave !== false,
  };
}
export type PrivateContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  sandboxed?: boolean;
  memoryAudience?: { kind: string; agentId: string };
  assertMemoryAudienceCurrent?: () => void;
  trigger?: string;
  jobId?: string;
  inputProvenance?: { kind: string };
};
export function privateContext(ctx: PrivateContext, cfg: Options): boolean {
  return (
    ctx.agentId === cfg.agentId &&
    ctx.sessionKey === cfg.sessionKey &&
    !!ctx.sessionId &&
    ctx.sandboxed === false &&
    ctx.memoryAudience?.kind === "owner-private" &&
    ctx.memoryAudience.agentId === cfg.agentId &&
    typeof ctx.assertMemoryAudienceCurrent === "function" &&
    !ctx.jobId &&
    !["cron", "heartbeat", "memory", "subagent"].includes(ctx.trigger ?? "") &&
    !/:(cron|subagent|incognito):/.test(ctx.sessionKey)
  );
}
export function assertPrivateContext(ctx: PrivateContext, cfg: Options) {
  if (!privateContext(ctx, cfg))
    throw new PennyError(
      "Penny private memory is limited to the configured owner main session.",
    );
  ctx.assertMemoryAudienceCurrent!();
}
export type SelectedFact = {
  content: string;
  fingerprint: string;
  sampleQuestions: [string, string, string];
};
export function selectFacts(messages: unknown[]): SelectedFact[] {
  const facts: SelectedFact[] = [];
  // Bound both examination and upload; only explicit durable user statements are eligible.
  for (const item of messages
    .slice(-12)
    .filter((v) => object(v) && v.role === "user")
    .slice(-1)) {
    if (
      !object(item) ||
      item.role !== "user" ||
      (object(item.provenance) && item.provenance.kind !== "external_user")
    )
      continue;
    let text = "";
    if (typeof item.content === "string") text = item.content;
    else if (Array.isArray(item.content))
      text = item.content
        .filter(
          (v) => object(v) && v.type === "text" && typeof v.text === "string",
        )
        .map((v) => (v as { text: string }).text)
        .join("\n");
    text = text.trim();
    if (
      text.length < 20 ||
      text.length > 1200 ||
      !/^(?:remember (?:that|this)\b|i (?:prefer|always|never)\b|we (?:decided|agreed)\b)/i.test(
        text,
      )
    )
      continue;
    if (
      /[\n\r]|```|<[^>]+>|\b(?:ignore .*instructions|system prompt|api.?key|password|credential|token|secret|private key)\b/i.test(
        text,
      )
    )
      continue;
    if (scrubCredentials(text) !== text) continue;
    const content = text.replace(/^remember (?:that|this)\s*:?\s*/i, "").trim();
    if (content.length < 12) continue;
    facts.push({
      content,
      fingerprint: createHash("sha256").update(content).digest("hex"),
      sampleQuestions: [
        `What did I ask Penny to remember about ${content.slice(0, 55)}?`,
        `What preference or decision did I record about ${content.slice(0, 55)}?`,
        `What should you recall when ${content.slice(0, 55)} comes up?`,
      ],
    });
    if (facts.length === 3) break;
  }
  return facts;
}

export function validateNote(value: unknown): {
  content: string;
  tags: string[];
  confidence: number;
  sampleQuestions: string[];
} {
  if (
    !object(value) ||
    typeof value.content !== "string" ||
    !value.content.trim() ||
    value.content.length > 20000 ||
    !Array.isArray(value.sample_questions) ||
    value.sample_questions.length !== 3 ||
    value.sample_questions.some(
      (s) => typeof s !== "string" || !s.trim() || s.length > 300,
    ) ||
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    (value.tags !== undefined &&
      (!Array.isArray(value.tags) ||
        value.tags.length > 10 ||
        value.tags.some((s) => typeof s !== "string" || s.length > 80)))
  )
    throw new PennyError(
      "Provide a bounded note, confidence, and exactly three natural questions.",
    );
  if (
    [
      value.content,
      ...value.sample_questions,
      ...((value.tags as string[]) ?? []),
    ].some((s) => scrubCredentials(s) !== s)
  )
    throw new PennyError("Remove credentials from the memory before saving.");
  return {
    content: value.content,
    tags: (value.tags ?? []) as string[],
    confidence: value.confidence,
    sampleQuestions: value.sample_questions as string[],
  };
}
