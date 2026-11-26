import * as admin from "firebase-admin";
import { generateApiKey, hashApiKey } from "../auth";
import { CLIENTS_COLLECTION } from "../firestoreStore";

/**
 * 呼び出し元アプリ（muse・ローカルアプリ等）ごとの API キーを発行する。**人間が実行する管理コマンド。**
 *   cd functions && npm run build
 *   GOOGLE_CLOUD_PROJECT=<project> node lib/decisionApi/admin/issueApiKey.js --client muse --name "Muse" [--daily-limit 500]
 *   node lib/decisionApi/admin/issueApiKey.js --client muse --revoke
 * 平文のキーは標準出力に1回だけ出す。保存されるのはハッシュのみ。
 * 再発行（ローテーション）は同じ --client で実行すると古いキーは無効になる。
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const clientId = arg("client");
  if (!clientId || !/^[\w-]{2,40}$/.test(clientId)) {
    console.error("--client <id>（英数字と - _、2〜40文字）が必要です");
    process.exit(1);
  }
  if (!admin.apps.length) admin.initializeApp();
  const ref = admin.firestore().collection(CLIENTS_COLLECTION).doc(clientId);

  if (process.argv.includes("--revoke")) {
    await ref.set({ isActive: false, revokedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    console.log(`client=${clientId} を無効化しました`);
    return;
  }

  const apiKey = generateApiKey();
  const dailyLimit = Number(arg("daily-limit") ?? 500);
  await ref.set(
    {
      name: arg("name") ?? clientId,
      keyHash: hashApiKey(apiKey),
      isActive: true,
      dailyLimit: Number.isFinite(dailyLimit) && dailyLimit > 0 ? dailyLimit : 500,
      rotatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  // 平文キーはここで1回だけ表示する（ログ・チャット・リポジトリに貼らないこと）
  process.stdout.write(`client=${clientId}\n${apiKey}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
