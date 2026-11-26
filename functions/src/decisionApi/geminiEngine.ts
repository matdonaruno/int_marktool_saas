import { Schema, Type } from "@google/genai";
import { executeStructuredTextTask } from "../utils/aiRouter";
import { CriticReferenceExample, evaluateCreative } from "../utils/criticAgent";
import { CriticRequest, DecideReferenceExample, DecideRequest, DecideResult, DecisionEngine, EngineMeta } from "./types";

/** 汎用判断プロンプトの版。変えたら上げる */
export const DECIDE_PROMPT_VERSION = "decide-v1";

const decideSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    recommendation: { type: Type.STRING, description: "選択肢があればその id。無ければ推奨する結論を1文で" },
    confidence: { type: Type.NUMBER, description: "0〜1。根拠の強さ。データが乏しければ低くする" },
    reasoning: { type: Type.STRING, description: "判断理由（判断基準ごとに簡潔に）" },
    keyFactors: { type: Type.ARRAY, items: { type: Type.STRING } },
    risks: { type: Type.ARRAY, items: { type: Type.STRING } },
    whatWouldChangeMyMind: { type: Type.STRING, description: "どんな事実・数値が出たら判断を変えるか" },
  },
  required: ["recommendation", "confidence", "reasoning", "keyFactors", "risks", "whatWouldChangeMyMind"],
};

/** 汎用判断のプロンプト（テスト可能な純粋関数） */
export function buildDecidePrompt(req: DecideRequest, references: DecideReferenceExample[]): string {
  const options = req.options.map((o) => `- id=${o.id}: ${o.label}${o.description ? ` — ${o.description}` : ""}`);
  const refs = references.map(
    (r, i) => `#${i + 1} [${r.outcomeLabel === "winner" ? "結果◎" : "結果×"}] 問い: ${r.question} / 当時の推奨: ${r.recommendation} / 実績: ${r.outcomeSummary}`
  );
  return [
    "あなたは意思決定アドバイザーです。与えられた情報だけを根拠に、判断材料として使える推奨を返してください。",
    "情報が不足している場合は推測で埋めず、confidence を下げて risks と whatWouldChangeMyMind に不足を書くこと。",
    `\n## 問い\n${req.question}`,
    options.length ? `\n## 選択肢（recommendation には id を入れる）\n${options.join("\n")}` : "",
    req.criteria.length ? `\n## 判断基準（優先順）\n${req.criteria.map((c) => `- ${c}`).join("\n")}` : "",
    `\n## 成果の評価軸\n${req.targetMetric.name} が${req.targetMetric.direction === "higher" ? "高い" : "低い"}ほど良い`,
    req.context ? `\n## 前提情報\n${req.context}` : "",
    refs.length ? `\n## 参考: 同じ利用者の過去の判断と実際の結果\n${refs.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeDecideResult(raw: DecideResult, req: DecideRequest): DecideResult {
  const confidence = Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0;
  const ids = new Set(req.options.map((o) => o.id));
  // 選択肢があるのに id 以外を返したら、確信度を 0 にして呼び出し側に気づかせる
  const isValidChoice = ids.size === 0 || ids.has(raw.recommendation);
  return {
    recommendation: String(raw.recommendation ?? ""),
    confidence: isValidChoice ? confidence : 0,
    reasoning: String(raw.reasoning ?? ""),
    keyFactors: raw.keyFactors ?? [],
    risks: isValidChoice ? raw.risks ?? [] : [...(raw.risks ?? []), "推奨が選択肢 id と一致しない"],
    whatWouldChangeMyMind: String(raw.whatWouldChangeMyMind ?? ""),
  };
}

export class GeminiDecisionEngine implements DecisionEngine {
  constructor(private readonly apiKey: string) {}

  async critic(req: CriticRequest, references: CriticReferenceExample[]) {
    const evaluation = await evaluateCreative(req.creative, this.apiKey, { context: req.context, referenceExamples: references });
    const { usedModelId, promptVersion, latencyMs, ...result } = evaluation;
    return { result, meta: { usedModelId, promptVersion, latencyMs } };
  }

  async decide(req: DecideRequest, references: DecideReferenceExample[]): Promise<{ result: DecideResult; meta: EngineMeta }> {
    const res = await executeStructuredTextTask<DecideResult>({
      role: "decisionAgent",
      prompt: buildDecidePrompt(req, references),
      responseSchema: decideSchema,
      apiKey: this.apiKey,
    });
    return {
      result: normalizeDecideResult(res.data, req),
      meta: { usedModelId: res.usedModelId, promptVersion: DECIDE_PROMPT_VERSION, latencyMs: res.latencyMs },
    };
  }
}
