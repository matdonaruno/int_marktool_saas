import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCalibration, splitWinnersAndLosers, spearman } from "./feedbackLoop";
import { DecisionRecord } from "./types";

function rec(id: string, score: number, ctr: number | undefined, promptVersion = "v1"): DecisionRecord {
  return {
    decisionId: id,
    clientId: "c",
    kind: "critic",
    topic: "t",
    targetMetric: { name: "ctr", direction: "higher" },
    input: { creative: { primaryText: id }, topic: "t", targetMetric: { name: "ctr", direction: "higher" } },
    output: { score, isPassed: score >= 80, weaknesses: [], improvementInstruction: "" },
    meta: { usedModelId: "m", promptVersion, latencyMs: 1, referenceCount: 0 },
    createdAt: "2026-11-26T00:00:00Z",
    latestOutcome: ctr === undefined ? undefined : { metrics: { ctr, cpa: 1000 / (ctr * 100) }, observedAt: "2026-11-27T00:00:00Z" },
    outcomeCount: ctr === undefined ? 0 : 1,
  };
}

test("spearman: 完全一致 1 / 逆順 -1 / 件数不足・分散ゼロは null", () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  assert.equal(spearman([1, 2], [1, 2]), null);
  assert.equal(spearman([5, 5, 5], [1, 2, 3]), null);
});

test("splitWinnersAndLosers: 4件未満は空、lower 指標は向きを反転", () => {
  assert.deepEqual(splitWinnersAndLosers([rec("a", 50, 0.01)], { name: "ctr", direction: "higher" }), { winners: [], losers: [] });
  const rs = [rec("a", 50, 0.01), rec("b", 50, 0.04), rec("c", 50, 0.02), rec("d", 50, 0.03)];
  const hi = splitWinnersAndLosers(rs, { name: "ctr", direction: "higher" });
  assert.deepEqual(hi.winners.map((r) => r.decisionId), ["b", "d"]);
  assert.deepEqual(hi.losers.map((r) => r.decisionId), ["a", "c"]);
  const lo = splitWinnersAndLosers(rs, { name: "cpa", direction: "lower" });
  assert.deepEqual(lo.winners.map((r) => r.decisionId), ["b", "d"], "CPA が低い = CTR が高い方が勝ち");
});

test("computeCalibration: 版ごとにスコアと成果の相関・合否別平均を出す", () => {
  const rs = [rec("a", 90, 0.04), rec("b", 85, 0.03), rec("c", 60, 0.01), rec("d", 40, 0.005), rec("e", 70, undefined), rec("f", 95, 0.001, "v2")];
  const groups = computeCalibration(rs, { name: "ctr", direction: "higher" });
  const v1 = groups.find((g) => g.promptVersion === "v1");
  assert.ok(v1);
  assert.equal(v1.decisions, 5);
  assert.equal(v1.withOutcome, 4);
  assert.equal(v1.rankCorrelation, 1);
  assert.equal(v1.passedMean, 0.035);
  assert.equal(v1.failedMean, 0.0075);
  assert.equal(groups.find((g) => g.promptVersion === "v2")?.withOutcome, 1);
});
