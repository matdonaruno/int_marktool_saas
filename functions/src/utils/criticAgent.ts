import { Type, Schema } from "@google/genai";
import { executeStructuredTextTask } from "./aiRouter";

/** MASTER_SPEC 第2章: Critic 合格ライン */
export const PASSING_CRITIC_SCORE = 80;

/** Critic プロンプトの版。変えたら上げる（フィードバック集計を版ごとに比較するため） */
export const CRITIC_PROMPT_VERSION = "critic-v2";

export interface CreativeForCritic {
  hook?: string;
  primaryText: string;
  headline?: string;
  angle?: string;
  imagePrompt?: string;
}

export interface CriticOutput {
  score: number;
  isPassed: boolean;
  weaknesses: string[];
  improvementInstruction: string;
}

/** 過去の採点と実績（フィードバックループで few-shot として渡す） */
export interface CriticReferenceExample {
  creative: CreativeForCritic;
  criticScore: number;
  outcomeSummary: string;
  outcomeLabel: "winner" | "loser";
}

export interface CriticEvaluation extends CriticOutput {
  usedModelId: string;
  promptVersion: string;
  latencyMs: number;
}

const criticSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    score: { type: Type.INTEGER, description: "100点満点中の総合スコア（80点以上で合格）" },
    isPassed: { type: Type.BOOLEAN, description: "80点以上かつ広告ポリシー違反がない場合はtrue" },
    weaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
    improvementInstruction: { type: Type.STRING },
  },
  required: ["score", "isPassed", "weaknesses", "improvementInstruction"],
};

function formatReferenceExamples(examples: CriticReferenceExample[]): string {
  if (examples.length === 0) return "";
  const rows = examples.map((ex, i) =>
    [
      `#${i + 1} [${ex.outcomeLabel === "winner" ? "実績◎" : "実績×"}] 当時のスコア:${ex.criticScore}`,
      `  広告: ${JSON.stringify(ex.creative)}`,
      `  実績: ${ex.outcomeSummary}`,
    ].join("\n")
  );
  return [
    "",
    "## 参考: 同じ利用者の過去の広告と実際の成果",
    "スコアと実績が食い違った例は、採点基準の見直しに使うこと（実績◎なのに低スコア＝減点しすぎ、実績×なのに高スコア＝見逃し）。",
    ...rows,
  ].join("\n");
}

/** Critic のプロンプトを組み立てる（テスト可能な純粋関数） */
export function buildCriticPrompt(
  creative: CreativeForCritic,
  options: { context?: string; referenceExamples?: CriticReferenceExample[] } = {}
): string {
  return [
    "以下のMeta広告案を100点満点で厳格採点してください（フック30点・独自性30点・Meta広告ポリシー遵守40点）。",
    "80点以上かつポリシー違反ゼロの場合のみ isPassed: true にしてください。",
    options.context ? `\n## 前提情報\n${options.context}` : "",
    formatReferenceExamples(options.referenceExamples ?? []),
    "\n## 採点対象",
    JSON.stringify(creative, null, 2),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Critic エージェントで広告案を採点する。
 * isPassed はモデルの自己申告に加え、スコアが合格ラインに届いているかでも判定する。
 */
export async function evaluateCreative(
  creative: CreativeForCritic,
  apiKey: string,
  options: { context?: string; referenceExamples?: CriticReferenceExample[] } = {}
): Promise<CriticEvaluation> {
  const res = await executeStructuredTextTask<CriticOutput>({
    role: "criticAgent",
    prompt: buildCriticPrompt(creative, options),
    responseSchema: criticSchema,
    apiKey,
  });
  const score = Math.max(0, Math.min(100, Math.round(res.data.score)));
  return {
    score,
    isPassed: res.data.isPassed && score >= PASSING_CRITIC_SCORE,
    weaknesses: res.data.weaknesses ?? [],
    improvementInstruction: res.data.improvementInstruction ?? "",
    usedModelId: res.usedModelId,
    promptVersion: CRITIC_PROMPT_VERSION,
    latencyMs: res.latencyMs,
  };
}
