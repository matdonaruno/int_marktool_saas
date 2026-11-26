#!/usr/bin/env bash
# 判断 API を「初回準備 → デプロイ → muse 用 API キー発行」まで1コマンドで行う。**人間が実行する。**
# 推奨: Google Cloud Shell（ブラウザで開くだけ。gcloud ログイン済み・インストール不要）
#   git clone https://github.com/matdonaruno/int_marktool_saas && cd int_marktool_saas
#   PROJECT_ID=<gcp-project> bash deploy/decision-api/bootstrap.sh
# 何度実行しても安全（作成済みのものは飛ばす）。
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-asia-northeast1}"
CLIENT_ID="${CLIENT_ID:-muse}"
[ -n "$PROJECT_ID" ] || { echo "❌ PROJECT_ID が空です。PROJECT_ID=<project> を付けて実行" >&2; exit 1; }
[ -f deploy/decision-api/deploy.sh ] || { echo "❌ リポジトリのルートで実行してください" >&2; exit 1; }

SA_NAME="decision-api"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
step() { echo; echo "=== $* ==="; }

echo "PROJECT_ID=$PROJECT_ID  REGION=$REGION  API キーを発行するアプリ=$CLIENT_ID"
echo "アカウント: $(gcloud config get-value account 2>/dev/null)"
read -r -p "この内容で進めますか？ [y/N] " yn
[ "$yn" = "y" ] || { echo "中止しました"; exit 1; }
gcloud config set project "$PROJECT_ID" >/dev/null

step "1/6 API を有効化"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com firestore.googleapis.com

step "2/6 Artifact Registry"
gcloud artifacts repositories describe decision-api --location "$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create decision-api --repository-format=docker --location "$REGION"

step "3/6 サービスアカウントと権限"
gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA_NAME" --display-name="Decision API (Cloud Run)"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/datastore.user" --condition=None >/dev/null
# Cloud Build（既定のコンピュート SA）がイメージを push・ログ出力できるように
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
[ -n "$PROJECT_NUMBER" ] || { echo "❌ プロジェクト番号を取得できません" >&2; exit 1; }
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for role in roles/artifactregistry.writer roles/logging.logWriter roles/storage.objectViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${BUILD_SA}" \
    --role="$role" --condition=None >/dev/null
done

step "4/6 Gemini の鍵（Secret Manager: GEMINI_API_KEY）"
if ! gcloud secrets describe GEMINI_API_KEY >/dev/null 2>&1; then
  echo "GEMINI_API_KEY が未登録です。値を入力してください（画面には表示されません）"
  read -r -s GEMINI_VALUE
  [ -n "$GEMINI_VALUE" ] || { echo "❌ 空です" >&2; exit 1; }
  printf '%s' "$GEMINI_VALUE" | gcloud secrets create GEMINI_API_KEY --data-file=- --replication-policy=automatic
  unset GEMINI_VALUE
fi
gcloud secrets add-iam-policy-binding GEMINI_API_KEY --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

step "5/6 Firestore の複合インデックス（decisionLog）"
gcloud firestore indexes composite create --collection-group=decisionLog --query-scope=COLLECTION \
  --field-config=field-path=clientId,order=ascending \
  --field-config=field-path=kind,order=ascending \
  --field-config=field-path=topic,order=ascending \
  --field-config=field-path=hasOutcome,order=ascending \
  --field-config=field-path=createdAt,order=descending --async 2>&1 | grep -v "already exists" || true

step "6/6 デプロイ（deploy.sh: 検証 → ビルド → Cloud Run → 事後検証）"
npm ci --no-audit --no-fund >/dev/null
npm --prefix functions ci --no-audit --no-fund >/dev/null
PROJECT_ID="$PROJECT_ID" REGION="$REGION" bash deploy/decision-api/deploy.sh

step "API キー発行（$CLIENT_ID）"
npm --prefix functions run build >/dev/null
URL="$(gcloud run services describe decision-api --region "$REGION" --format 'value(status.url)')"
echo "下の2行を $CLIENT_ID の秘匿情報ストアに入れてください（このキーは再表示できません。チャット等に貼らない）:"
echo "DECISION_API_URL=$URL"
printf 'DECISION_API_KEY='
GOOGLE_CLOUD_PROJECT="$PROJECT_ID" node functions/lib/decisionApi/admin/issueApiKey.js \
  --client "$CLIENT_ID" --name "$CLIENT_ID" | tail -1
echo
echo "✅ 完了"
