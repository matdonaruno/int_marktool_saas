import { createServer } from "node:http";
import * as admin from "firebase-admin";
import { createDecisionApiHandler } from "./app";
import { FirestoreDecisionStore } from "./firestoreStore";
import { GeminiDecisionEngine } from "./geminiEngine";

/**
 * Cloud Run エントリポイント。
 * 環境変数:
 *   PORT                 Cloud Run が設定（既定 8080）
 *   GEMINI_API_KEY       Secret Manager から --set-secrets で注入（平文で env 指定しない）
 *   ALLOWED_ORIGINS      任意。ブラウザから呼ぶオリジンのカンマ区切り
 * Firestore は Cloud Run のサービスアカウント（ADC）で接続する。
 */
const REQUEST_TIMEOUT_MS = 120000;
const MISSING_CREDENTIAL_MESSAGE = "Gemini の認証情報が環境にありません。デプロイ時にシークレットマネージャから注入してください";

function main(): void {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    console.error(MISSING_CREDENTIAL_MESSAGE);
    process.exit(1);
  }
  if (!admin.apps.length) admin.initializeApp();

  const handler = createDecisionApiHandler({
    store: new FirestoreDecisionStore(admin.firestore()),
    engine: new GeminiDecisionEngine(geminiKey),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  });

  const server = createServer((req, res) => void handler(req, res));
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = 30000;
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => console.log(JSON.stringify({ severity: "INFO", message: `decision-api listening on ${port}` })));

  // Cloud Run はスケールイン時に SIGTERM を送る。処理中のリクエストを終えてから終了する
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

main();
