import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { createDecisionApiHandler, redact } from "./app";
import { hashApiKey } from "./auth";
import { MemoryDecisionStore } from "./memoryStore";
import { CriticReferenceExample } from "../utils/criticAgent";
import { fetchWithTimeout } from "../utils/fetchWithTimeout";
import { CriticRequest, DecideReferenceExample, DecideRequest, DecisionEngine } from "./types";

const KEY_A = "dak_test_client_a";
const KEY_B = "dak_test_client_b";

/** 採点は primaryText の長さで決まり、渡された few-shot 件数を記録するフェイク */
class FakeEngine implements DecisionEngine {
  criticReferences: CriticReferenceExample[][] = [];
  decideReferences: DecideReferenceExample[][] = [];
  async critic(req: CriticRequest, references: CriticReferenceExample[]) {
    this.criticReferences.push(references);
    const score = Math.min(100, req.creative.primaryText.length);
    return {
      result: { score, isPassed: score >= 80, weaknesses: [], improvementInstruction: "" },
      meta: { usedModelId: "fake-model", promptVersion: "critic-test", latencyMs: 1 },
    };
  }
  async decide(req: DecideRequest, references: DecideReferenceExample[]) {
    this.decideReferences.push(references);
    return {
      result: { recommendation: req.options[0]?.id ?? "yes", confidence: 0.7, reasoning: "r", keyFactors: [], risks: [], whatWouldChangeMyMind: "w" },
      meta: { usedModelId: "fake-model", promptVersion: "decide-test", latencyMs: 1 },
    };
  }
}

async function startApp(dailyLimit = 100) {
  const store = new MemoryDecisionStore();
  store.addClient(hashApiKey(KEY_A), { clientId: "muse", name: "Muse", isActive: true, dailyLimit });
  store.addClient(hashApiKey(KEY_B), { clientId: "local", name: "Local", isActive: true, dailyLimit });
  const engine = new FakeEngine();
  let seq = 0;
  const handler = createDecisionApiHandler({ store, engine, newId: () => `d${++seq}`, now: () => new Date(Date.UTC(2026, 10, 26, 0, 0, seq)) });
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, key: string | null = KEY_A) => {
    const res = await fetchWithTimeout(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }, 5000);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { engine, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const critic = (text: string) => ({ creative: { primaryText: text }, topic: "ads" });

test("healthz は認証なしで 200、/v1 は API キー必須", async (t) => {
  const app = await startApp();
  t.after(app.close);
  assert.equal((await app.call("GET", "/healthz", undefined, null)).status, 200);
  assert.equal((await app.call("POST", "/v1/critic", critic("x"), null)).status, 401);
  assert.equal((await app.call("POST", "/v1/critic", critic("x"), "dak_wrong")).status, 401);
});

test("入力検証: 400 / 413 / 404 / 405", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const bad = await app.call("POST", "/v1/critic", { creative: {} });
  assert.equal(bad.status, 400);
  assert.ok(Array.isArray(bad.json.details));
  assert.equal((await app.call("POST", "/v1/critic", "{not json")).status, 400);
  assert.equal((await app.call("POST", "/v1/critic", critic("a".repeat(70 * 1024)))).status, 413);
  assert.equal((await app.call("GET", "/v1/nope")).status, 404);
  assert.equal((await app.call("GET", "/v1/critic")).status, 405);
});

test("critic → 成果フィードバック → 次回の採点に過去実績が few-shot で入る", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const ctrs = [0.031, 0.004, 0.022, 0.008];
  for (let i = 0; i < ctrs.length; i++) {
    const r = await app.call("POST", "/v1/critic", critic(`広告案${i} ` + "x".repeat(60 + i * 10)));
    assert.equal(r.status, 200);
    assert.equal(r.json.decisionId, `d${i + 1}`);
    const fb = await app.call("POST", `/v1/decisions/${r.json.decisionId}/outcomes`, { metrics: { impressions: 1000, ctr: ctrs[i] } });
    assert.equal(fb.status, 202);
    assert.equal(fb.json.isUsedForLearning, true);
  }
  assert.equal(app.engine.criticReferences[0].length, 0, "成果がないうちは few-shot なし");
  await app.call("POST", "/v1/critic", critic("新しい広告案"));
  const refs = app.engine.criticReferences.at(-1) ?? [];
  assert.equal(refs.length, 4);
  assert.deepEqual(refs.map((r) => r.outcomeLabel), ["winner", "winner", "loser", "loser"]);
  assert.match(refs[0].outcomeSummary, /ctr=0\.0310/);
});

test("targetMetric が無い成果は受け付けるが学習には使わないと返す", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const r = await app.call("POST", "/v1/critic", critic("x"));
  const fb = await app.call("POST", `/v1/decisions/${r.json.decisionId}/outcomes`, { metrics: { clicks: 3 } });
  assert.equal(fb.status, 202);
  assert.equal(fb.json.isUsedForLearning, false);
  assert.match(String(fb.json.warning), /ctr/);
  assert.equal((await app.call("POST", `/v1/decisions/${r.json.decisionId}/outcomes`, { metrics: { ctr: "high" } })).status, 400);
});

test("テナント分離: 他アプリの判断は 404", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const r = await app.call("POST", "/v1/critic", critic("x"));
  assert.equal((await app.call("GET", `/v1/decisions/${r.json.decisionId}`, undefined, KEY_B)).status, 404);
  assert.equal((await app.call("POST", `/v1/decisions/${r.json.decisionId}/outcomes`, { metrics: { ctr: 1 } }, KEY_B)).status, 404);
  assert.equal((await app.call("GET", `/v1/decisions/${r.json.decisionId}`)).status, 200);
});

test("日次上限を超えたら 429（AI を呼ばない）", async (t) => {
  const app = await startApp(2);
  t.after(app.close);
  assert.equal((await app.call("POST", "/v1/critic", critic("x"))).status, 200);
  assert.equal((await app.call("POST", "/v1/critic", critic("x"))).status, 200);
  assert.equal((await app.call("POST", "/v1/critic", critic("x"))).status, 429);
  assert.equal(app.engine.criticReferences.length, 2);
});

test("decide: 選択肢つき判断と insights（判断と成果の相関）", async (t) => {
  const app = await startApp();
  t.after(app.close);
  const body = { question: "どちらの LP を使う？", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], criteria: ["CVR"], topic: "lp", targetMetric: { name: "cvr", direction: "higher" } };
  const r = await app.call("POST", "/v1/decide", body);
  assert.equal(r.status, 200);
  assert.equal(r.json.recommendation, "a");
  await app.call("POST", `/v1/decisions/${r.json.decisionId}/outcomes`, { metrics: { cvr: 0.02 } });
  const ins = await app.call("GET", "/v1/insights?kind=decide&topic=lp&metric=cvr");
  assert.equal(ins.status, 200);
  const groups = ins.json.groups as { withOutcome: number; promptVersion: string }[];
  assert.equal(groups[0].withOutcome, 1);
  assert.equal(groups[0].promptVersion, "decide-test");
});

test("AI 側の認証エラーは 502 と直し方を返し、ログ用の文字列は鍵を伏せる", async (t) => {
  const store = new MemoryDecisionStore();
  store.addClient(hashApiKey(KEY_A), { clientId: "muse", name: "Muse", isActive: true, dailyLimit: 10 });
  const failing: DecisionEngine = {
    critic: async () => { throw new Error('{"error":{"code":400,"message":"API key not valid","status":"INVALID_ARGUMENT"}}'); },
    decide: async () => { throw new Error("RESOURCE_EXHAUSTED"); },
  };
  const handler = createDecisionApiHandler({ store, engine: failing });
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetchWithTimeout(base + path, { method: "POST", headers: { Authorization: `Bearer ${KEY_A}` }, body: JSON.stringify(body) }, 5000);
  const r1 = await post("/v1/critic", { creative: { primaryText: "x" } });
  assert.equal(r1.status, 502);
  assert.match(((await r1.json()) as { error: string }).error, /GEMINI_API_KEY/);
  assert.equal((await post("/v1/decide", { question: "q" })).status, 503);

  const fakeGoogleKey = "AIza" + "C".repeat(35);
  const leaked = `GET https://x/v1?key=${fakeGoogleKey}&alt=json token ${fakeGoogleKey} dak_abcdefghijklmnop`;
  const out = redact(leaked);
  assert.ok(!out.includes(fakeGoogleKey));
  assert.ok(!out.includes("dak_abcdefghijklmnop"));
  assert.match(out, /key=\*\*\*/);
});
