# 判断 API（Cloud Run）

muse やローカルアプリなど、**どのアプリからでも HTTP で呼べる「判断の材料」API**。
判断を返すだけでなく、**後から実際の成果数値を受け取り、次の判断に反映する**（フィードバックループ）。
将来の SaaS 化を見据えて、呼び出し元アプリ＝テナントとして分離してある。

```
 muse / ローカルアプリ / 本アプリ
        │  Authorization: Bearer dak_...（アプリごとの API キー）
        ▼
 Cloud Run: decision-api ── functions/src/decisionApi/（functions と同じコード・同じ aiRouter / Critic）
   POST /v1/critic   広告クリエイティブの Critic 採点（MASTER_SPEC の Critic と同一ロジック）
   POST /v1/decide   汎用の判断（問い・選択肢・判断基準 → 推奨・確信度・理由・リスク）
   POST /v1/decisions/{id}/outcomes   実際の成果数値（フィードバック）
   GET  /v1/decisions/{id}            判断と最新の成果
   GET  /v1/insights                  判断が成果を当てているか（版ごとの相関）
        │
        ▼
 Firestore: decisionApiClients / decisionLog（クライアント SDK からはアクセス不可）
 Gemini: aiRouter 経由（criticAgent / decisionAgent ロール。モデルは systemConfig/aiModels で切替）
```

## 1. 認証

- アプリごとに API キーを発行する（`dak_` で始まる 256bit 乱数）。保存されるのは SHA-256 ハッシュだけ。
- 送り方: `Authorization: Bearer <key>`（または `X-Api-Key: <key>`）。
- **キーをブラウザ（フロントエンドの JS）に埋め込まない。** muse がブラウザアプリなら、muse のサーバー側から呼ぶ。
- アプリごとに日次上限（既定 500 回/日、AI を呼ぶ `/v1/critic`・`/v1/decide` のみカウント）。超えると 429。
- 発行・ローテーション・失効は §5.3（人間が実行）。

## 2. エンドポイント

### POST /v1/critic — 広告クリエイティブを採点

```json
{
  "creative": { "primaryText": "必須", "hook": "任意", "headline": "任意", "angle": "任意" },
  "context": "任意: 商品・ターゲット等の前提",
  "topic": "任意: 学習を分ける単位（例: product-123）。既定 default",
  "targetMetric": { "name": "ctr", "direction": "higher" }
}
```

応答（200）:

```json
{
  "decisionId": "…",
  "score": 84, "isPassed": true,
  "weaknesses": ["…"], "improvementInstruction": "…",
  "meta": { "usedModelId": "…", "promptVersion": "critic-v2", "latencyMs": 2100, "referenceCount": 6 },
  "feedbackUrl": "/v1/decisions/…/outcomes"
}
```

`targetMetric` の既定は `ctr`（高いほど良い）。CPA で学習させたいなら `{ "name": "cpa", "direction": "lower" }`。

### POST /v1/decide — 汎用の判断

```json
{
  "question": "来月の予算をどちらに寄せるべきか",
  "options": [{ "id": "a", "label": "Instagram リール" }, { "id": "b", "label": "Facebook フィード" }],
  "criteria": ["CPA", "学習の安定性"],
  "context": "直近30日: リール CPA 3,200円 / フィード CPA 2,800円 …",
  "topic": "budget-allocation",
  "targetMetric": { "name": "cpa", "direction": "lower" }
}
```

応答: `recommendation`（選択肢があればその id）、`confidence`（0〜1）、`reasoning`、`keyFactors`、`risks`、`whatWouldChangeMyMind`。
選択肢があるのに id 以外を返した場合は `confidence: 0` にして `risks` に明記する（呼び出し側が機械的に弾けるように）。

### POST /v1/decisions/{decisionId}/outcomes — 成果のフィードバック（202）

```json
{ "metrics": { "impressions": 12000, "clicks": 310, "ctr": 0.0258, "cpa": 2650 }, "observedAt": "2026-11-29T00:00:00Z", "note": "任意" }
```

- 何度送ってもよい（全履歴を保存し、学習には最新を使う）。数値は有限の number のみ。
- 判断時の `targetMetric` が `metrics` に無いと `isUsedForLearning: false` と警告が返る（保存はされる）。

### GET /v1/insights?kind=critic&topic=…&metric=ctr&direction=higher

版（プロンプト版 × モデル）ごとに、判断と成果の関係を返す:
`rankCorrelation`（Critic スコア／decide の確信度と成果の順位相関。1 に近いほど当たっている）、
`passedMean` / `failedMean`（Critic で合格にした広告と不合格の広告の成果平均）。

## 3. フィードバックループの仕組み

1. **記録**: すべての判断を入力・出力・モデル・プロンプト版つきで `decisionLog` に残す。
2. **成果の受け取り**: 呼び出し側が、結果が出た時点で `outcomes` に実数値を送る。
3. **即時の改善（few-shot）**: 次の判断時、同じアプリ・同じ `topic` で成果が付いた過去判断が **4件以上**あれば、
   `targetMetric` の中央値で勝ち/負けに分け、上位3件と下位3件を「過去の実績」としてプロンプトに入れる。
   Critic には「実績◎なのに低スコア＝減点しすぎ、実績×なのに高スコア＝見逃し」として採点基準の補正に使わせる。
4. **改訂の判断材料**: `/v1/insights` で版ごとの相関を見る。相関が低い・合格群と不合格群の成果に差がない
   ＝ Critic が成果を当てていない。プロンプトを改訂して `CRITIC_PROMPT_VERSION` / `DECIDE_PROMPT_VERSION` を上げ、
   新旧の版を insights で比べる。**版の切替・モデル昇格は人間が判断する**（自動では書き換えない）。

`topic` は「成果を比べて意味がある単位」にする（商品・LP・キャンペーン種別など）。混ぜると勝ち負けの境目がぼやける。

## 4. 呼び出し側の実装例（TypeScript / Node 18+）

```ts
const BASE = process.env.DECISION_API_URL!;            // 例: https://decision-api-xxxx.a.run.app
const KEY = process.env.DECISION_API_KEY!;             // アプリのサーバー側の環境変数に置く

async function callDecisionApi<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`decision-api ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// 1) 判断をもらう（decisionId を自分のデータに保存しておく）
const verdict = await callDecisionApi<{ decisionId: string; score: number; isPassed: boolean }>("/v1/critic", {
  creative: { primaryText: "…", headline: "…" },
  topic: "product-123",
});

// 2) 数日後、実績が出たら返す（これがループの燃料）
await callDecisionApi(`/v1/decisions/${verdict.decisionId}/outcomes`, {
  metrics: { impressions: 12000, ctr: 0.0258, cpa: 2650 },
});
```

本アプリ内では `autopilotMonitor`（8時間ごとの Insights 取得）が成果数値を持っているので、
将来ここから自動で `outcomes` を送れば、人手なしでループが回る（未実装・次の候補）。

## 5. デプロイと運用（**人間が実行**。AI はハーネスでブロックされる）

**最短手順（推奨）**: Google Cloud Shell（ブラウザで開くだけ・ログイン済み）で次の2行。§5.1〜5.3 を1コマンドで行い、最後に muse に入れる URL とキーを表示する。

```bash
git clone https://github.com/matdonaruno/int_marktool_saas && cd int_marktool_saas
```

```bash
PROJECT_ID=<PROJECT_ID> bash deploy/decision-api/bootstrap.sh
```

以下は個別に実行したい場合の内訳。

### 5.1 初回のみ: GCP の準備

```bash
gcloud config set project <PROJECT_ID>
```

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firestore.googleapis.com
```

```bash
gcloud artifacts repositories create decision-api --repository-format=docker --location=asia-northeast1
```

```bash
gcloud iam service-accounts create decision-api --display-name="Decision API (Cloud Run)"
```

```bash
gcloud projects add-iam-policy-binding <PROJECT_ID> --member="serviceAccount:decision-api@<PROJECT_ID>.iam.gserviceaccount.com" --role="roles/datastore.user"
```

```bash
gcloud secrets add-iam-policy-binding GEMINI_API_KEY --member="serviceAccount:decision-api@<PROJECT_ID>.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
```

`GEMINI_API_KEY` は MASTER_SPEC 第3章で `firebase functions:secrets:set` 済みのものを共用する（同じ Secret Manager）。

```bash
firebase deploy --only firestore:indexes
```

（`decisionLog` の複合インデックス。`firestore.indexes.json`）

### 5.2 デプロイ（毎回）

```bash
PROJECT_ID=<PROJECT_ID> bash deploy/decision-api/deploy.sh
```

スクリプトは: 未コミット変更・main 以外からの実行を拒否 → 設定を表示して確認 → `harness:verify` →
Cloud Build でイメージ作成 → Cloud Run にデプロイ（`--max-instances 3`、Secret は Secret Manager から注入）→
`/healthz` が 200・無認証が 401 であることを別コマンドで検証、まで行う。

### 5.3 API キーの発行・ローテーション・失効

```bash
gcloud auth application-default login
```

```bash
npm --prefix functions run build
```

```bash
GOOGLE_CLOUD_PROJECT=<PROJECT_ID> node functions/lib/decisionApi/admin/issueApiKey.js --client muse --name "Muse" --daily-limit 500
```

- 平文キーは1回だけ表示される。**呼び出し側アプリのサーバーの環境変数（Secret）に直接入れ、チャット・リポジトリ・メモに貼らない。**
- 同じ `--client` で再実行するとキーが入れ替わり、古いキーは即無効（ローテーション）。
- 失効: 同じコマンドに `--revoke`。

### 5.4 呼び出し側アプリへの登録

| アプリ | キーの置き場所 | 呼び出し元 | 備考 |
|---|---|---|---|
| muse | muse の秘匿情報ストア（`DECISION_API_KEY`）と `DECISION_API_URL` | muse のサーバー側 | 秘匿情報を保持できるため中継不要。`ALLOWED_ORIGINS`（CORS）も設定しない |
| ローカルアプリ | OS のキーチェーン / シークレット管理（Doppler 等）。`.env` に置く場合は必ず .gitignore 済みであること | ローカルプロセス | 公開リポジトリにキーを書かない |

- キーはアプリごとに別々に発行する（`--client muse`、`--client <ローカルアプリ名>`）。1つ漏れても他は止めずに済む。
- 漏えいを疑ったら、そのアプリだけ `--revoke` → 再発行 → アプリ側の秘匿情報を差し替え。

## 6. コストと安全のガード

| ガード | 値 | 場所 |
|---|---|---|
| アプリごとの日次上限 | 既定 500 回/日（429） | `decisionApiClients/{id}.dailyLimit` |
| Cloud Run 最大インスタンス | 3 | `deploy.sh` |
| AI 呼び出しタイムアウト / リトライ | 60 秒 / 最大 3 回 | `utils/aiRouter.ts` |
| リクエスト本文 | 64KB まで（413） | `decisionApi/app.ts` |
| テナント分離 | 他アプリの判断は 404 | `decisionApi/app.ts` |
| CORS | 既定は無効（`ALLOWED_ORIGINS` で明示した場合のみ） | `decisionApi/server.ts` |

## 7. 既知の限界・次の候補

- 成果の自動送信（`autopilotMonitor` → `outcomes`）は未実装。今は呼び出し側が送る。
- few-shot は直近 200 件からの選抜。件数が増えたら topic ごとの集計ジョブ（Cloud Scheduler）に移す。
- SaaS 化時: API キーのテナントを Firebase Auth のユーザー/組織に紐付け、日次上限を Stripe のプランと連動させる。
