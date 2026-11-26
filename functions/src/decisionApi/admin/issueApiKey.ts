import * as admin from "firebase-admin";
import { generateApiKey, hashApiKey } from "../auth";
import { createFileDecisionStore, DEFAULT_LOCAL_DATA_PATH, findRunningServer } from "../fileStore";
import { CLIENTS_COLLECTION } from "../firestoreStore";

/**
 * 呼び出し元アプリ（muse・ローカルアプリ等）ごとの API キーを発行する。**人間が実行する管理コマンド。**
 *   ローカルモード:  node functions/lib/decisionApi/admin/issueApiKey.js --local --client muse
 *   Cloud Run 用:    GOOGLE_CLOUD_PROJECT=<project> node functions/lib/decisionApi/admin/issueApiKey.js --client muse --name "Muse"
 *   失効:            上記に --revoke を付ける
 * 平文のキーは標準出力に1回だけ出す。保存されるのはハッシュのみ。
 * 同じ --client で再実行するとキーが入れ替わり、古いキーは無効になる（ローテーション）。
 * サーバー起動中に --local で発行した場合は、サーバーを再起動すると反映される。
 */
const DEFAULT_DAILY_LIMIT = 500;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readOptions() {
  const clientId = arg("client");
  if (!clientId || !/^[\w-]{2,40}$/.test(clientId)) {
    console.error("--client <id>（英数字と - _、2〜40文字）が必要です");
    process.exit(1);
  }
  const limit = Number(arg("daily-limit") ?? DEFAULT_DAILY_LIMIT);
  return {
    clientId,
    name: arg("name") ?? clientId,
    dailyLimit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_DAILY_LIMIT,
    isRevoke: process.argv.includes("--revoke"),
  };
}

function runLocal(opts: ReturnType<typeof readOptions>): string | null {
  const path = process.env.DECISION_API_DATA || DEFAULT_LOCAL_DATA_PATH;
  const running = findRunningServer(path);
  if (running) {
    console.error(`ローカルサーバーが起動中です（PID ${running}）。Ctrl+C で止めてから実行してください（起動中に書くとキーが消えるため）`);
    process.exit(1);
  }
  const store = createFileDecisionStore(path);
  if (opts.isRevoke) {
    console.log(store.revokeClient(opts.clientId) ? `client=${opts.clientId} を無効化しました（${path}）` : `client=${opts.clientId} は未登録です`);
    return null;
  }
  const apiKey = generateApiKey();
  store.addClient(hashApiKey(apiKey), { clientId: opts.clientId, name: opts.name, isActive: true, dailyLimit: opts.dailyLimit });
  return apiKey;
}

async function runFirestore(opts: ReturnType<typeof readOptions>): Promise<string | null> {
  if (!admin.apps.length) admin.initializeApp();
  const ref = admin.firestore().collection(CLIENTS_COLLECTION).doc(opts.clientId);
  if (opts.isRevoke) {
    await ref.set({ isActive: false, revokedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    console.log(`client=${opts.clientId} を無効化しました`);
    return null;
  }
  const apiKey = generateApiKey();
  await ref.set(
    { name: opts.name, keyHash: hashApiKey(apiKey), isActive: true, dailyLimit: opts.dailyLimit, rotatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  return apiKey;
}

async function main(): Promise<void> {
  const opts = readOptions();
  const apiKey = process.argv.includes("--local") ? runLocal(opts) : await runFirestore(opts);
  // 平文キーはここで1回だけ表示する（ログ・チャット・リポジトリに貼らないこと）
  if (apiKey) process.stdout.write(`client=${opts.clientId}\n${apiKey}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
