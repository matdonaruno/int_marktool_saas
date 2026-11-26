import { CriticReferenceExample } from "../utils/criticAgent";
import { CriticRequest, CriticResult, DecideReferenceExample, DecideRequest, DecideResult, DecisionRecord, TargetMetric } from "./types";

/**
 * フィードバックループ:
 *  1. 判断ごとに後から実際の成果数値（metrics）を受け取る
 *  2. 次の判断時、同じ利用者・同じ topic の「成果が良かった/悪かった過去例」を few-shot としてプロンプトに入れる（即時の改善）
 *  3. 判断と成果の相関（キャリブレーション）を版ごとに集計し、プロンプト/モデル改訂の判断材料にする（人が見て改訂する）
 */

/** few-shot に入れるための最低件数。少なすぎると勝ち負けの境目が意味を持たない */
export const MIN_OUTCOMES_FOR_REFERENCE = 4;
export const REFERENCES_PER_SIDE = 3;

/** 成果数値を「大きいほど良い」向きにそろえた値。対象指標が無ければ null */
export function orientedMetric(record: Pick<DecisionRecord, "latestOutcome">, target: TargetMetric): number | null {
  const v = record.latestOutcome?.metrics[target.name];
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return target.direction === "higher" ? v : -v;
}

export function summarizeOutcome(record: DecisionRecord): string {
  const m = record.latestOutcome?.metrics ?? {};
  return Object.entries(m)
    .slice(0, 8)
    .map(([k, v]) => `${k}=${Number.isInteger(v) ? v : v.toFixed(4)}`)
    .join(", ");
}

/** 対象指標の中央値で勝ち/負けに分け、それぞれ上位/下位 n 件を返す */
export function splitWinnersAndLosers(records: DecisionRecord[], target: TargetMetric, n = REFERENCES_PER_SIDE) {
  const scored = records
    .map((r) => ({ r, v: orientedMetric(r, target) }))
    .filter((x): x is { r: DecisionRecord; v: number } => x.v !== null)
    .sort((a, b) => b.v - a.v);
  if (scored.length < MIN_OUTCOMES_FOR_REFERENCE) return { winners: [], losers: [] };
  const mid = Math.floor(scored.length / 2);
  return {
    winners: scored.slice(0, Math.min(n, mid)).map((x) => x.r),
    losers: scored.slice(scored.length - Math.min(n, scored.length - mid)).reverse().map((x) => x.r),
  };
}

export function buildCriticReferences(records: DecisionRecord[], target: TargetMetric): CriticReferenceExample[] {
  const { winners, losers } = splitWinnersAndLosers(records.filter((r) => r.kind === "critic"), target);
  const toExample = (r: DecisionRecord, label: "winner" | "loser"): CriticReferenceExample => ({
    creative: (r.input as CriticRequest).creative,
    criticScore: (r.output as CriticResult).score,
    outcomeSummary: summarizeOutcome(r),
    outcomeLabel: label,
  });
  return [...winners.map((r) => toExample(r, "winner")), ...losers.map((r) => toExample(r, "loser"))];
}

export function buildDecideReferences(records: DecisionRecord[], target: TargetMetric): DecideReferenceExample[] {
  const { winners, losers } = splitWinnersAndLosers(records.filter((r) => r.kind === "decide"), target);
  const toExample = (r: DecisionRecord, label: "winner" | "loser"): DecideReferenceExample => ({
    question: (r.input as DecideRequest).question.slice(0, 500),
    recommendation: (r.output as DecideResult).recommendation,
    outcomeSummary: summarizeOutcome(r),
    outcomeLabel: label,
  });
  return [...winners.map((r) => toExample(r, "winner")), ...losers.map((r) => toExample(r, "loser"))];
}

/** 順位（同順位は平均順位） */
function ranks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k].i] = avg;
    i = j + 1;
  }
  return out;
}

/** スピアマンの順位相関。3件未満や分散ゼロなら null */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
}

export interface CalibrationGroup {
  promptVersion: string;
  usedModelId: string;
  decisions: number;
  withOutcome: number;
  /** Critic: スコアと成果の順位相関（1に近いほどスコアが成果を当てている） / decide: 確信度と成果の順位相関 */
  rankCorrelation: number | null;
  /** Critic のみ: 合格判定した広告と不合格の広告の成果平均（向きそろえ前の生値） */
  passedMean: number | null;
  failedMean: number | null;
}

const meanOrNull = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/** 判断材料: 版（プロンプト×モデル）ごとに「判断が成果を当てているか」を集計する */
export function computeCalibration(records: DecisionRecord[], target: TargetMetric): CalibrationGroup[] {
  const groups = new Map<string, DecisionRecord[]>();
  for (const r of records) {
    const key = `${r.meta.promptVersion}|${r.meta.usedModelId}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([key, rs]) => {
    const [promptVersion, usedModelId] = key.split("|");
    const withOutcome = rs.filter((r) => orientedMetric(r, target) !== null);
    const judged = withOutcome.map((r) =>
      r.kind === "critic" ? (r.output as CriticResult).score : (r.output as DecideResult).confidence
    );
    const outcomes = withOutcome.map((r) => orientedMetric(r, target) as number);
    const raw = (r: DecisionRecord) => r.latestOutcome?.metrics[target.name] as number;
    const critics = withOutcome.filter((r) => r.kind === "critic");
    return {
      promptVersion,
      usedModelId,
      decisions: rs.length,
      withOutcome: withOutcome.length,
      rankCorrelation: spearman(judged, outcomes),
      passedMean: meanOrNull(critics.filter((r) => (r.output as CriticResult).isPassed).map(raw)),
      failedMean: meanOrNull(critics.filter((r) => !(r.output as CriticResult).isPassed).map(raw)),
    };
  });
}
