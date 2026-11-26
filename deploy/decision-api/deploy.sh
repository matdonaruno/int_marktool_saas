#!/usr/bin/env bash
# 判断 API を Cloud Run にデプロイする。**人間が手動で実行する**（docs/GITHUB_RULES.md G10）。
#   PROJECT_ID=<gcp-project> bash deploy/decision-api/deploy.sh
# 初回セットアップ（API 有効化・Artifact Registry・サービスアカウント）は docs/DECISION_API.md §5 を先に行う。
# 安全ルール S1/S4/S6: 変数を assert → 内容を表示 → 確認 → 実行 → 別コマンドで検証。
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-asia-northeast1}"
SERVICE="decision-api"
REPO="decision-api"
SA_EMAIL="decision-api@${PROJECT_ID}.iam.gserviceaccount.com"

[ -n "$PROJECT_ID" ] || { echo "❌ PROJECT_ID が空です。PROJECT_ID=<project> を付けて実行" >&2; exit 1; }
[ -n "$REGION" ] || { echo "❌ REGION が空です" >&2; exit 1; }
[ -f deploy/decision-api/Dockerfile ] || { echo "❌ リポジトリルートで実行してください" >&2; exit 1; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ 未コミットの変更があります。コミット済みの状態からデプロイしてください" >&2; exit 1
fi
if [ "$BRANCH" != "main" ] && [ "${ALLOW_NON_MAIN:-}" != "1" ]; then
  echo "❌ main 以外（$BRANCH）からのデプロイは ALLOW_NON_MAIN=1 が必要です" >&2; exit 1
fi

SHA="$(git rev-parse --short HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}:${SHA}"

echo "=== Pre-flight ==="
echo "  PROJECT_ID : $PROJECT_ID"
echo "  REGION     : $REGION"
echo "  SERVICE    : $SERVICE"
echo "  IMAGE      : $IMAGE"
echo "  BRANCH/SHA : $BRANCH / $SHA"
echo "  ACCOUNT    : $(gcloud config get-value account 2>/dev/null)"
read -r -p "この内容でビルドしてデプロイしますか？ [y/N] " yn
[ "$yn" = "y" ] || { echo "中止しました"; exit 1; }

echo "=== 1/3 ローカル検証 ==="
npm run harness:verify

echo "=== 2/3 Cloud Build でイメージ作成 ==="
gcloud builds submit --project "$PROJECT_ID" --config deploy/decision-api/cloudbuild.yaml \
  --substitutions "_IMAGE=${IMAGE}" .

echo "=== 3/3 Cloud Run へデプロイ ==="
# --allow-unauthenticated: 認証はアプリ層の API キーで行う（ローカルアプリから gcloud なしで呼べるように）
# --max-instances / 日次上限: 暴走時のコスト上限
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" --image "$IMAGE" \
  --service-account "$SA_EMAIL" \
  --set-secrets "GEMINI_API_KEY=GEMINI_API_KEY:latest" \
  --allow-unauthenticated \
  --max-instances 3 --concurrency 20 --timeout 120 --memory 512Mi --cpu 1

echo "=== 事後検証 ==="
URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"
[ -n "$URL" ] || { echo "❌ サービス URL を取得できません" >&2; exit 1; }
HEALTH="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$URL/healthz")"
NOAUTH="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$URL/v1/critic" -H 'Content-Type: application/json' -d '{}')"
echo "  $URL/healthz        → $HEALTH (期待 200)"
echo "  $URL/v1/critic 無認証 → $NOAUTH (期待 401)"
[ "$HEALTH" = "200" ] && [ "$NOAUTH" = "401" ] || { echo "❌ 事後検証に失敗。gcloud run services logs read $SERVICE で確認" >&2; exit 1; }
echo "✅ デプロイ検証済み: $URL"
