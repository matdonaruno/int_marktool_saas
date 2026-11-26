import { createServer } from "node:http";
import * as admin from "firebase-admin";
import { useStaticRouting } from "../utils/aiRouter";
import { createDecisionApiHandler } from "./app";
import { acquireServerLock, createFileDecisionStore, DEFAULT_LOCAL_DATA_PATH } from "./fileStore";
import { FirestoreDecisionStore } from "./firestoreStore";
import { GeminiDecisionEngine } from "./geminiEngine";
import { DecisionStore } from "./types";

/**
 * 判断 API のエントリポイント。
 * 環境変数:
 *   GEMINI_API_KEY       必須。Cloud Run では Secret Manager から注入（平文で env 指定しない）
 *   DECISION_API_STORE   "firestore"（既定・Cloud Run）か "file"（ローカルモード。GCP 不要）
 *   DECISION_API_DATA    ローカルモードの保存先（既定 ~/.decision-api/data.json）
 *   PORT                 既定 8080（ローカルの npm スクリプトは 8787）
 *   HOST                 ローカルモードの既定は 127.0.0.1（同じ PC からのみ接続可）
 *   ALLOWED_ORIGINS      任意。ブラウザから呼ぶオリジンのカンマ区切り
 */
const REQUEST_TIMEOUT_MS = 120000;
const MISSING_CREDENTIAL_MESSAGE = "Gemini の認証情報が環境にありません（ローカルは環境変数、Cloud Run はシークレットマネージャから注入）";

function createStore(isLocal: boolean): { store: DecisionStore; label: string; release: () => void } {
  if (isLocal) {
    const path = process.env.DECISION_API_DATA || DEFAULT_LOCAL_DATA_PATH;
    useStaticRouting();
    // 起動中にキー発行コマンドが同じファイルを書き換えて、キーが消えるのを防ぐ
    const release = acquireServerLock(path);
    return { store: createFileDecisionStore(path), label: `file:${path}`, release };
  }
  if (!admin.apps.length) admin.initializeApp();
  return { store: new FirestoreDecisionStore(admin.firestore()), label: "firestore", release: () => undefined };
}

function main(): void {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    console.error(MISSING_CREDENTIAL_MESSAGE);
    process.exit(1);
  }
  const isLocal = process.env.DECISION_API_STORE === "file";
  let created: ReturnType<typeof createStore>;
  try {
    created = createStore(isLocal);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const { store, label, release } = created;

  const handler = createDecisionApiHandler({
    store,
    engine: new GeminiDecisionEngine(geminiKey),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  });

  const server = createServer((req, res) => void handler(req, res));
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = 30000;
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? (isLocal ? "127.0.0.1" : "0.0.0.0");
  server.listen(port, host, () =>
    console.log(JSON.stringify({ severity: "INFO", message: `decision-api listening on http://${host}:${port}`, store: label }))
  );

  // Cloud Run はスケールイン時に SIGTERM を送る。処理中のリクエストを終えてから終了する
  const shutdown = () =>
    server.close(() => {
      release();
      process.exit(0);
    });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
