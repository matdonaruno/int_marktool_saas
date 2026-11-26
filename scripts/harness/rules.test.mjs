// node --test scripts/harness/
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFile } from "./lib/rules.mjs";

const ids = (path, content) => checkFile(path, content).map((v) => v.ruleId);

test("SPEC-1.4.6: モデルIDの直書きは aiRouter 以外で禁止", () => {
  assert.deepEqual(ids("functions/src/foo.ts", 'const m = "gemini-2.5-pro";'), ["SPEC-1.4.6/no-hardcoded-model-id"]);
  assert.deepEqual(ids("functions/src/utils/aiRouter.ts", 'modelId: "gemini-2.5-pro"'), []);
  assert.deepEqual(ids("app/page.tsx", "const m = 'claude-opus-4';"), ["SPEC-1.4.6/no-hardcoded-model-id"]);
});

test("SPEC-1.4.1: トークンを console 出力しない", () => {
  assert.deepEqual(ids("functions/src/a.ts", "console.log(accessToken);"), ["SPEC-1.4.1/no-token-log"]);
  assert.deepEqual(ids("functions/src/a.ts", 'console.log("done");'), []);
});

test("SPEC-1.4.2: クライアントから encryptedAccessToken に触れない", () => {
  assert.deepEqual(ids("app/dashboard/page.tsx", "data.metaConnection.encryptedAccessToken"), ["SPEC-1.4.2/no-client-token-access"]);
  assert.deepEqual(ids("functions/src/a.ts", "metaConn.encryptedAccessToken"), []);
});

test("SPEC-1.4.3: functions では生 fetch 禁止、fetchWithTimeout は可", () => {
  assert.deepEqual(ids("functions/src/a.ts", "const r = await fetch(url);"), ["SPEC-1.4.3/fetch-needs-timeout"]);
  assert.deepEqual(ids("functions/src/a.ts", "const r = await fetchWithTimeout(url);"), []);
  assert.deepEqual(ids("functions/src/utils/fetchWithTimeout.ts", "return await fetch(url, init);"), []);
});

test("SPEC-1.3: any 禁止", () => {
  assert.deepEqual(ids("types/index.ts", "let x: any = 1;"), ["SPEC-1.3/no-any"]);
  assert.deepEqual(ids("types/index.ts", "const y = z as any;"), ["SPEC-1.3/no-any"]);
  assert.deepEqual(ids("types/index.ts", "const company = 1; // many"), []);
});

test("SPEC-1.4.4: ACTIVE 化には assertCanActivate が必要", () => {
  const bad = 'const s = isOn ? "ACTIVE" : "PAUSED";';
  assert.deepEqual(ids("functions/src/publish.ts", bad), ["SPEC-1.4.4/activation-needs-guard"]);
  assert.deepEqual(ids("functions/src/publish.ts", `await assertCanActivate(x);\n${bad}`), []);
  assert.deepEqual(ids("functions/src/idx.ts", 'url.searchParams.append("ad_active_status", "ACTIVE");'), []);
});

test("SPEC-1.4.5: adcreatives は OPT_OUT 必須", () => {
  const base = "postToMetaApi(`${id}/adcreatives`, {})";
  assert.deepEqual(ids("functions/src/p.ts", base), ["SPEC-1.4.5/advantage-plus-opt-out"]);
  const ok = `${base}\ndegrees_of_freedom_spec: { x: { enroll_status: "OPT_OUT" } }`;
  assert.deepEqual(ids("functions/src/p.ts", ok), []);
});

test("G5: シークレットらしき値とコミット禁止ファイル", () => {
  const fakeStripe = "sk_" + "live_" + "a".repeat(24);
  assert.deepEqual(ids("functions/src/a.ts", `const k = "${fakeStripe}";`), ["GH-G5/no-secrets"]);
  const fakeGoogle = "AIza" + "B".repeat(35);
  assert.deepEqual(ids("README.md", fakeGoogle), ["GH-G5/no-secrets"]);
  assert.deepEqual(ids(".env", ""), ["GH-G5/forbidden-file"]);
  assert.deepEqual(ids(".env.local", ""), ["GH-G5/forbidden-file"]);
  assert.deepEqual(ids(".env.local.example", "NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key"), []);
  assert.deepEqual(ids("keys/my-proj-firebase-adminsdk-abc.json", "{}"), ["GH-G5/forbidden-file"]);
  assert.deepEqual(ids("memo_spec.txt", ""), ["GH-G5/forbidden-file"]);
});

test("S4/S5: 公開 Security Rules と機密ファイル名", () => {
  assert.deepEqual(ids("storage.rules", "      allow read: if true;"), ["SAFETY-4/no-public-rules"]);
  assert.deepEqual(ids("firestore.rules", "allow read, write: if request.auth != null;"), []);
  assert.deepEqual(ids("keys/AuthKey_ABC123.p8", ""), ["GH-G5/forbidden-file"]);
  assert.deepEqual(ids("config/gcp-credentials.json", "{}"), ["GH-G5/forbidden-file"]);
  assert.deepEqual(ids(".zsh_history", ""), ["GH-G5/forbidden-file"]);
});
