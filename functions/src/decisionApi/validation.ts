import { CriticRequest, DecideOption, DecideRequest, OutcomeInput, TargetMetric } from "./types";

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const MAX_TEXT = 8000;
const MAX_OPTIONS = 10;
const MAX_METRICS = 30;
const TOPIC_RE = /^[\w.\-:/]{1,64}$/;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function optionalText(body: Json, key: string, errors: string[], max = MAX_TEXT): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    errors.push(`${key} は文字列`);
    return undefined;
  }
  if (v.length > max) errors.push(`${key} は ${max} 文字以内`);
  return v;
}

function requiredText(body: Json, key: string, errors: string[], max = MAX_TEXT): string {
  const v = optionalText(body, key, errors, max);
  if (!v || !v.trim()) errors.push(`${key} は必須`);
  return v ?? "";
}

function parseTopic(body: Json, errors: string[]): string {
  const topic = optionalText(body, "topic", errors, 64) ?? "default";
  if (!TOPIC_RE.test(topic)) errors.push("topic は英数字と ._-:/ の 64 文字以内");
  return topic;
}

function parseTargetMetric(body: Json, fallback: TargetMetric, errors: string[]): TargetMetric {
  const v = body.targetMetric;
  if (v === undefined) return fallback;
  if (!isObject(v) || typeof v.name !== "string" || !/^[\w.]{1,40}$/.test(v.name)) {
    errors.push("targetMetric.name は英数字 40 文字以内");
    return fallback;
  }
  if (v.direction !== "higher" && v.direction !== "lower") {
    errors.push('targetMetric.direction は "higher" か "lower"');
    return fallback;
  }
  return { name: v.name, direction: v.direction };
}

/** Critic の既定評価軸: 広告クリエイティブの良し悪しが最も直接出る CTR */
export const DEFAULT_CRITIC_METRIC: TargetMetric = { name: "ctr", direction: "higher" };

export function parseCriticRequest(body: unknown): Parsed<CriticRequest> {
  if (!isObject(body) || !isObject(body.creative)) return { ok: false, errors: ["creative オブジェクトは必須"] };
  const errors: string[] = [];
  const c = body.creative;
  const creative = {
    primaryText: requiredText(c, "primaryText", errors),
    hook: optionalText(c, "hook", errors, 500),
    headline: optionalText(c, "headline", errors, 500),
    angle: optionalText(c, "angle", errors, 500),
    imagePrompt: optionalText(c, "imagePrompt", errors, 2000),
  };
  const value: CriticRequest = {
    creative,
    context: optionalText(body, "context", errors),
    topic: parseTopic(body, errors),
    targetMetric: parseTargetMetric(body, DEFAULT_CRITIC_METRIC, errors),
  };
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function parseOptions(raw: unknown, errors: string[]): DecideOption[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_OPTIONS) {
    errors.push(`options は ${MAX_OPTIONS} 件以内の配列`);
    return [];
  }
  const options: DecideOption[] = [];
  raw.forEach((o, i) => {
    if (!isObject(o) || typeof o.id !== "string" || typeof o.label !== "string" || !o.id || !o.label) {
      errors.push(`options[${i}] は { id, label } が必須`);
      return;
    }
    options.push({ id: o.id.slice(0, 64), label: o.label.slice(0, 500), description: typeof o.description === "string" ? o.description.slice(0, 2000) : undefined });
  });
  if (new Set(options.map((o) => o.id)).size !== options.length) errors.push("options の id が重複");
  return options;
}

export function parseDecideRequest(body: unknown): Parsed<DecideRequest> {
  if (!isObject(body)) return { ok: false, errors: ["JSON オブジェクトを送ること"] };
  const errors: string[] = [];
  const criteriaRaw = body.criteria;
  const criteria =
    Array.isArray(criteriaRaw) && criteriaRaw.every((c) => typeof c === "string")
      ? (criteriaRaw as string[]).slice(0, 10).map((c) => c.slice(0, 500))
      : [];
  if (criteriaRaw !== undefined && criteria.length === 0 && (!Array.isArray(criteriaRaw) || criteriaRaw.length > 0)) {
    errors.push("criteria は文字列の配列");
  }
  const value: DecideRequest = {
    question: requiredText(body, "question", errors, 2000),
    options: parseOptions(body.options, errors),
    criteria,
    context: optionalText(body, "context", errors),
    topic: parseTopic(body, errors),
    targetMetric: parseTargetMetric(body, { name: "score", direction: "higher" }, errors),
  };
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function parseOutcome(body: unknown): Parsed<OutcomeInput> {
  if (!isObject(body) || !isObject(body.metrics)) return { ok: false, errors: ["metrics オブジェクトは必須"] };
  const errors: string[] = [];
  const entries = Object.entries(body.metrics);
  if (entries.length === 0 || entries.length > MAX_METRICS) errors.push(`metrics は 1〜${MAX_METRICS} 項目`);
  const metrics: Record<string, number> = {};
  for (const [k, v] of entries) {
    if (!/^[\w.]{1,40}$/.test(k)) errors.push(`metrics のキー ${k.slice(0, 40)} は英数字 40 文字以内`);
    else if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`metrics.${k} は有限の数値`);
    else metrics[k] = v;
  }
  const observedAt = optionalText(body, "observedAt", errors, 40);
  if (observedAt && Number.isNaN(Date.parse(observedAt))) errors.push("observedAt は ISO 8601 日時");
  const value: OutcomeInput = { metrics, observedAt, note: optionalText(body, "note", errors, 2000) };
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
