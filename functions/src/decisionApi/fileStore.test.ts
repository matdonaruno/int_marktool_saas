import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireServerLock, createFileDecisionStore, findRunningServer } from "./fileStore";

test("fileStore: サーバー起動中はロックで検出でき、二重起動を拒否、解除後は null", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "decision-api-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "data.json");
  assert.equal(findRunningServer(path), null);
  const release = acquireServerLock(path);
  assert.equal(findRunningServer(path), process.pid);
  assert.throws(() => acquireServerLock(path), /起動中/);
  release();
  assert.equal(findRunningServer(path), null);
});

test("fileStore: 再起動しても判断・成果・キーが残る / キーのローテーションと失効", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "decision-api-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "nested", "data.json");

  const a = createFileDecisionStore(path);
  a.addClient("hash-old", { clientId: "muse", name: "Muse", isActive: true, dailyLimit: 10 });
  a.addClient("hash-new", { clientId: "muse", name: "Muse", isActive: true, dailyLimit: 10 });
  await a.saveDecision({
    decisionId: "d1", clientId: "muse", kind: "critic", topic: "t",
    targetMetric: { name: "ctr", direction: "higher" },
    input: { creative: { primaryText: "x" }, topic: "t", targetMetric: { name: "ctr", direction: "higher" } },
    output: { score: 80, isPassed: true, weaknesses: [], improvementInstruction: "" },
    meta: { usedModelId: "m", promptVersion: "v", latencyMs: 1, referenceCount: 0 },
    createdAt: "2026-11-26T00:00:00Z", outcomeCount: 0,
  });
  await a.addOutcome("d1", { metrics: { ctr: 0.02 }, observedAt: "2026-11-27T00:00:00Z" });
  assert.equal((statSync(path).mode & 0o777).toString(8), "600");

  const b = createFileDecisionStore(path);
  assert.equal(await b.findClientByKeyHash("hash-old"), null, "古いキーは消える");
  assert.equal((await b.findClientByKeyHash("hash-new"))?.clientId, "muse");
  assert.equal((await b.getDecision("d1"))?.latestOutcome?.metrics.ctr, 0.02);
  assert.equal((await b.listDecisionsWithOutcome("muse", "critic", "t", 10)).length, 1);

  assert.equal(b.revokeClient("muse"), true);
  assert.equal((await createFileDecisionStore(path).findClientByKeyHash("hash-new"))?.isActive, false);
});
