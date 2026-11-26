// node --test scripts/harness/
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCommand } from "./lib/gitPolicy.mjs";

const blocked = (cmd, ctx = { currentBranch: "feat/x" }) => checkCommand(cmd, ctx).length > 0;

test("G1: 保護ブランチへの push / commit を止める", () => {
  assert.ok(blocked("git push origin main"));
  assert.ok(blocked("git push origin HEAD:main"));
  assert.ok(blocked("git push", { currentBranch: "main" }));
  assert.ok(blocked('git commit -m "x"', { currentBranch: "main" }));
  assert.ok(!blocked("git push -u origin feat/x"));
  assert.ok(!blocked("git push -u origin claude/awesome-cannon-mtpas4"));
});

test("G2: force push / 履歴書き換えを止める", () => {
  assert.ok(blocked("git push --force origin feat/x"));
  assert.ok(blocked("git push -f origin feat/x"));
  assert.ok(blocked("git push --force-with-lease origin feat/x"));
  assert.ok(blocked("git push origin +feat/x"));
  assert.ok(blocked("git filter-repo --path secret.txt --invert-paths"));
});

test("G4: リモートブランチ削除・branch -D を止める", () => {
  assert.ok(blocked("git push origin --delete feat/old"));
  assert.ok(blocked("git push origin :feat/old"));
  assert.ok(blocked("git branch -D feat/old"));
  assert.ok(!blocked("git branch -d feat/merged"));
});

test("G5: git add -A / . と .env の閲覧を止める", () => {
  assert.ok(blocked("git add -A"));
  assert.ok(blocked("git add ."));
  assert.ok(!blocked("git add functions/src/a.ts docs/HARNESS.md"));
  assert.ok(blocked("cat .env.local"));
  assert.ok(!blocked("cat .env.local.example"));
  assert.ok(blocked("gh secret set FOO"));
});

test("G6/G7: 破壊的操作とフック迂回を止める", () => {
  assert.ok(blocked("git reset --hard origin/main"));
  assert.ok(blocked("git clean -fd"));
  assert.ok(blocked('git commit --no-verify -m "x"'));
  assert.ok(blocked('git commit -nm "x"'));
  assert.ok(!blocked('git commit -m "fix: n"'));
  assert.ok(blocked("git config --unset core.hooksPath"));
  assert.ok(!blocked("git config core.hooksPath .githooks"));
});

test("G8/G10: マージ・デプロイ・シークレット操作は人間", () => {
  assert.ok(blocked("gh pr merge 3 --squash"));
  assert.ok(blocked("firebase deploy --only functions"));
  assert.ok(blocked("firebase functions:secrets:set GEMINI_API_KEY"));
  assert.ok(!blocked("firebase emulators:start"));
});

test("複合コマンドの後段も検査する / クォート内は分割しない", () => {
  assert.ok(blocked("npm test && git push origin main"));
  assert.ok(!blocked('git commit -m "docs: main と && の説明"'));
});

test("S1: 空変数が / に展開される rm -rf を止める（空変数事故の型）", () => {
  assert.ok(blocked('rm -rf "$SMALL/"'));
  assert.ok(blocked("rm -rf $HOME"));
  assert.ok(blocked("rm -rf /"));
  assert.ok(blocked("rm -rf ~/"));
  assert.ok(!blocked('[ -n "$OUT" ] && [ "$OUT" != "/" ] && rm -rf "$OUT/cache"'));
  assert.ok(!blocked('rm -rf "${OUT:?}/cache"'));
  assert.ok(!blocked("rm -rf functions/lib"));
  assert.ok(blocked("sudo rm x"));
  assert.ok(blocked("chmod -R 777 ."));
});

test("S4/S5: クラウド一括転送・DB 破壊・シークレット削除を止める", () => {
  assert.ok(blocked('rclone copy "$SRC/" r2:bucket/'));
  assert.ok(blocked("aws s3 sync . s3://b"));
  assert.ok(blocked("gsutil -m rsync -r out gs://b"));
  assert.ok(blocked("gsutil cp a.png gs://my-proj.appspot.com/"));
  assert.ok(blocked("gcloud storage rm -r gs://b"));
  assert.ok(blocked("supabase db reset"));
  assert.ok(blocked('psql -c "DROP TABLE users"'));
  assert.ok(blocked("doppler secrets unset FOO"));
  assert.ok(blocked("FOO=1 rclone sync a b"));
  assert.ok(!blocked("rclone ls r2:bucket"));
});

test("誤検知しない: hooksPath の読み取り", () => {
  assert.ok(!blocked("git config core.hooksPath"));
  assert.ok(!blocked("git config --get core.hooksPath"));
  assert.ok(blocked("git config core.hooksPath /dev/null"));
});

test("G10/G5: Cloud Run 判断 API のデプロイ・キー発行は人間", () => {
  assert.ok(blocked("gcloud run deploy decision-api --image x"));
  assert.ok(blocked("gcloud builds submit --config deploy/decision-api/cloudbuild.yaml ."));
  assert.ok(blocked("gcloud secrets versions add GEMINI_API_KEY --data-file=-"));
  assert.ok(blocked("PROJECT_ID=p bash deploy/decision-api/deploy.sh"));
  assert.ok(blocked("node lib/decisionApi/admin/issueApiKey.js --client muse"));
  assert.ok(blocked("docker push asia-northeast1-docker.pkg.dev/p/r/i:1"));
  assert.ok(!blocked("gcloud run services describe decision-api --region asia-northeast1"));
  assert.ok(!blocked("docker build -f deploy/decision-api/Dockerfile ."));
  assert.ok(blocked("./deploy/decision-api/deploy.sh"));
  assert.ok(blocked("bash -x deploy/decision-api/deploy.sh"));
  assert.ok(!blocked("bash -n deploy/decision-api/deploy.sh"));
});

test("誤検知しない: スクリプトのパスに触れるだけの操作", () => {
  assert.ok(!blocked("chmod +x deploy/decision-api/deploy.sh"));
  assert.ok(!blocked("git add deploy/decision-api/deploy.sh functions/src/decisionApi/admin/issueApiKey.ts"));
  assert.ok(!blocked("bash -n deploy/decision-api/Dockerfile"));
});
