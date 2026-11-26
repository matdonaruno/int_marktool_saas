import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { extractApiKey, hashApiKey } from "./auth";
import { buildCriticReferences, buildDecideReferences, computeCalibration } from "./feedbackLoop";
import { ApiClient, DecisionEngine, DecisionKind, DecisionRecord, DecisionStore, TargetMetric } from "./types";
import { DEFAULT_CRITIC_METRIC, parseCriticRequest, parseDecideRequest, parseOutcome } from "./validation";

export const MAX_BODY_BYTES = 64 * 1024;
/** few-shot・集計のために読む過去判断の上限 */
const HISTORY_LIMIT = 200;

export interface AppDeps {
  store: DecisionStore;
  engine: DecisionEngine;
  now?: () => Date;
  newId?: () => string;
  /** ブラウザから呼ぶ場合のみ。API キーをブラウザに埋め込む構成は推奨しない */
  allowedOrigins?: string[];
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: string[]) {
    super(message);
  }
}

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; deps: Required<Omit<AppDeps, "allowedOrigins">> };
type Handler = (ctx: Ctx, client: ApiClient, params: string[]) => Promise<unknown>;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `リクエストは ${MAX_BODY_BYTES} バイト以内`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "JSON として読めません");
  }
}

function unwrap<T>(parsed: { ok: true; value: T } | { ok: false; errors: string[] }): T {
  if (!parsed.ok) throw new HttpError(400, "入力が不正です", parsed.errors);
  return parsed.value;
}

async function authenticate(ctx: Ctx): Promise<ApiClient> {
  const key = extractApiKey(ctx.req.headers);
  if (!key) throw new HttpError(401, "API キーが必要です（Authorization: Bearer <key>）");
  const client = await ctx.deps.store.findClientByKeyHash(hashApiKey(key));
  if (!client || !client.isActive) throw new HttpError(401, "API キーが無効です");
  return client;
}

/** AI を呼ぶ経路だけ日次上限を数える（暴走・コスト事故の防止） */
async function enforceDailyLimit(ctx: Ctx, client: ApiClient): Promise<void> {
  const day = ctx.deps.now().toISOString().slice(0, 10);
  const used = await ctx.deps.store.incrementDailyUsage(client.clientId, day);
  if (used > client.dailyLimit) throw new HttpError(429, `本日の上限 ${client.dailyLimit} 回に達しました`);
}

function newRecord(ctx: Ctx, client: ApiClient, partial: Pick<DecisionRecord, "kind" | "topic" | "targetMetric" | "input" | "output" | "meta">): DecisionRecord {
  return { ...partial, decisionId: ctx.deps.newId(), clientId: client.clientId, createdAt: ctx.deps.now().toISOString(), outcomeCount: 0 };
}

const handleCritic: Handler = async (ctx, client) => {
  const input = unwrap(parseCriticRequest(await readJson(ctx.req)));
  await enforceDailyLimit(ctx, client);
  const history = await ctx.deps.store.listDecisionsWithOutcome(client.clientId, "critic", input.topic, HISTORY_LIMIT);
  const references = buildCriticReferences(history, input.targetMetric);
  const { result, meta } = await ctx.deps.engine.critic(input, references);
  const record = newRecord(ctx, client, { kind: "critic", topic: input.topic, targetMetric: input.targetMetric, input, output: result, meta: { ...meta, referenceCount: references.length } });
  await ctx.deps.store.saveDecision(record);
  return { decisionId: record.decisionId, ...result, meta: record.meta, feedbackUrl: `/v1/decisions/${record.decisionId}/outcomes` };
};

const handleDecide: Handler = async (ctx, client) => {
  const input = unwrap(parseDecideRequest(await readJson(ctx.req)));
  await enforceDailyLimit(ctx, client);
  const history = await ctx.deps.store.listDecisionsWithOutcome(client.clientId, "decide", input.topic, HISTORY_LIMIT);
  const references = buildDecideReferences(history, input.targetMetric);
  const { result, meta } = await ctx.deps.engine.decide(input, references);
  const record = newRecord(ctx, client, { kind: "decide", topic: input.topic, targetMetric: input.targetMetric, input, output: result, meta: { ...meta, referenceCount: references.length } });
  await ctx.deps.store.saveDecision(record);
  return { decisionId: record.decisionId, ...result, meta: record.meta, feedbackUrl: `/v1/decisions/${record.decisionId}/outcomes` };
};

async function loadOwnDecision(ctx: Ctx, client: ApiClient, decisionId: string): Promise<DecisionRecord> {
  const record = await ctx.deps.store.getDecision(decisionId);
  // 他テナントの判断は存在しないものとして扱う（ID の存在を漏らさない）
  if (!record || record.clientId !== client.clientId) throw new HttpError(404, "判断が見つかりません");
  return record;
}

const handleGetDecision: Handler = async (ctx, client, [decisionId]) => loadOwnDecision(ctx, client, decisionId);

const handleOutcome: Handler = async (ctx, client, [decisionId]) => {
  const outcome = unwrap(parseOutcome(await readJson(ctx.req)));
  const record = await loadOwnDecision(ctx, client, decisionId);
  const observedAt = outcome.observedAt ?? ctx.deps.now().toISOString();
  const updated = await ctx.deps.store.addOutcome(record.decisionId, { ...outcome, observedAt });
  const hasTarget = typeof outcome.metrics[record.targetMetric.name] === "number";
  return {
    decisionId,
    outcomeCount: updated?.outcomeCount ?? record.outcomeCount + 1,
    isUsedForLearning: hasTarget,
    warning: hasTarget ? undefined : `targetMetric "${record.targetMetric.name}" が metrics に無いため、学習には使われません`,
  };
};

const handleInsights: Handler = async (ctx, client) => {
  const kindParam = ctx.url.searchParams.get("kind") ?? "critic";
  if (kindParam !== "critic" && kindParam !== "decide") throw new HttpError(400, 'kind は "critic" か "decide"');
  const kind: DecisionKind = kindParam;
  const topic = ctx.url.searchParams.get("topic") ?? "default";
  const fallback = kind === "critic" ? DEFAULT_CRITIC_METRIC : { name: "score", direction: "higher" as const };
  const direction = ctx.url.searchParams.get("direction");
  const target: TargetMetric = {
    name: ctx.url.searchParams.get("metric") ?? fallback.name,
    direction: direction === "lower" || direction === "higher" ? direction : fallback.direction,
  };
  const history = await ctx.deps.store.listDecisionsWithOutcome(client.clientId, kind, topic, HISTORY_LIMIT);
  return { kind, topic, targetMetric: target, groups: computeCalibration(history, target) };
};

const ROUTES: { method: string; pattern: RegExp; handler: Handler }[] = [
  { method: "POST", pattern: /^\/v1\/critic$/, handler: handleCritic },
  { method: "POST", pattern: /^\/v1\/decide$/, handler: handleDecide },
  { method: "GET", pattern: /^\/v1\/decisions\/([\w-]{1,64})$/, handler: handleGetDecision },
  { method: "POST", pattern: /^\/v1\/decisions\/([\w-]{1,64})\/outcomes$/, handler: handleOutcome },
  { method: "GET", pattern: /^\/v1\/insights$/, handler: handleInsights },
];

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function applyCors(req: IncomingMessage, res: ServerResponse, allowed: string[]): boolean {
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, X-Api-Key, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method !== "OPTIONS") return false;
  res.writeHead(origin && allowed.includes(origin) ? 204 : 403).end();
  return true;
}

async function dispatch(ctx: Ctx): Promise<{ status: number; body: unknown; clientId?: string }> {
  if (ctx.req.method === "GET" && ctx.url.pathname === "/healthz") return { status: 200, body: { ok: true } };
  const route = ROUTES.find((r) => r.pattern.test(ctx.url.pathname));
  if (!route) throw new HttpError(404, "Not Found");
  if (route.method !== ctx.req.method) throw new HttpError(405, "Method Not Allowed");
  const client = await authenticate(ctx);
  const params = route.pattern.exec(ctx.url.pathname)?.slice(1) ?? [];
  const body = await route.handler(ctx, client, params);
  return { status: route.method === "POST" && /outcomes$/.test(ctx.url.pathname) ? 202 : 200, body, clientId: client.clientId };
}

/** node:http 用のリクエストハンドラを作る */
export function createDecisionApiHandler(deps: AppDeps) {
  const resolved = { now: () => new Date(), newId: () => randomUUID(), ...deps };
  const allowed = deps.allowedOrigins ?? [];
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    if (applyCors(req, res, allowed)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const ctx: Ctx = { req, res, url, deps: resolved };
    let status = 500;
    let clientId: string | undefined;
    try {
      const out = await dispatch(ctx);
      ({ status, clientId } = out);
      send(res, status, out.body);
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, "内部エラー");
      status = e.status;
      if (!(err instanceof HttpError)) console.error("decision-api unhandled error:", err instanceof Error ? err.message : String(err));
      send(res, e.status, { error: e.message, details: e.details });
    }
    console.log(JSON.stringify({ severity: status >= 500 ? "ERROR" : "INFO", method: req.method, path: url.pathname, status, clientId, latencyMs: Date.now() - started }));
  };
}
