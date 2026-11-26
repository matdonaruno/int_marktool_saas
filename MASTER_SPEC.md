# AI Ad Autopilot SaaS — 完全版マスター仕様書＆開発規約 (`MASTER_SPEC.md`)

> **【AIアシスタント・開発者への引き継ぎ指示】**
> 本ドキュメントは、本アプリケーションをゼロから完全構築するための**唯一かつ絶対の設計図・開発規約**です。コードを生成・改修する際は、必ず「第1章：開発ルールと禁止事項」を厳守し、既存の共通モジュールを確認した上で実装を進めてください。

---

## 第0章：ベースモデル（Crush AI）の内部構造・完全解剖レポート

本アプリケーションの設計ベースとなっているAI広告運用自動化サービス「Crush AI（trycrush.ai / Crush, UAB）」の内部アーキテクチャと成功要因のすべてを記録する。

### 0.1 Crush AIの全体パイプライン（End-to-End 処理フロー）
1. **商品URLスクレイピング＆ブランドDNA抽出**：個別商品LPのURLから「ブランドカラー（HEXコード）」「ターゲットの悩み（Pain Points）」「独自性（USP）」「顧客レビュー」を自動抽出しブランドプロファイルを構築する。
2. **ナイトリー更新型・競合広告ライブラリ（Nightly Ad Indexer）**：毎晩バッチ処理でMeta広告をインデックス化。「配信継続期間（14日以上）」を勝ち広告の指標とし、フック・訴求軸・構成を抽出する。
3. **勝ちパターンの再構築＆Critic（批評エージェント）検品ループ**：生成AIの出力をそのまま入稿せず、別のAIエージェント（Critic）が80点以上の品質基準・広告ポリシー違反を採点。不合格なら自動修正ループ（最大3回）を回す。
4. **人間による承認（Human-in-the-loop）とMeta API直接入稿**：承認後またはAutopilot設定時にMeta広告（Campaign / AdSet / AdCreative / Ad）へ直接入稿する。
5. **8時間ごとのパフォーマンス監視＆アンチバーン保護**：
   * **アンチバーン保護（Anti-Burn Protection）**：LPのリンク切れ（404等）を検知したら即座に全キャンペーンを緊急停止（`PAUSED`）する。
   * **機械的損切り**：1,000インプレッション到達後、目標CPAの1.5倍消化でCVゼロ、またはCPA超過＆ROAS未達の広告を即座に自動停止（`killed`）する。
6. **マルチSNS毎日オーガニック投稿**：有料広告はMeta一点集中としつつ、生成素材を流用してInstagram・Facebook等へ毎日無料投稿を自動配信する。

---

## 第1章：開発ルール・コーディング規約（AI＆人間共通の絶対遵守事項）

### 1.1 実装前チェックと重複防止ワークフロー（Strict Workflow）
1. **既存コード・共通モジュールの確認**：`functions/src/utils/` および `types/` を確認し、同等の処理・型定義が既に存在しないか確認する。
2. **全体データフローへのマッピング確認**：入力・Firestore読み書き・出力の繋がりを設計図と照合する。
3. **共通化（DRY原則）の適用**：2箇所以上で使われるロジック（暗号化、Meta API呼び出し、AIモデルルーティング、LP死活監視）は必ず `functions/src/utils/` に切り出す。

### 1.2 変数・定数・ファイル命名規則
- **変数・関数名**：`camelCase`（動詞＋目的語。例: `fetchMetaInsights`, `encryptedAccessToken`）
- **真偽値（Boolean）**：`is` / `has` / `should` / `can` で始める（例: `isAutopilotEnabled`, `isLpHealthy`）
- **定数・環境変数**：`UPPER_SNAKE_CASE`（例: `MAX_RETRY_ATTEMPTS`, `META_BASE_URL`）
- **型・インターフェース**：`PascalCase`（接頭辞 `I` 禁止。例: `CreativeDocument`, `GuardrailConfig`）
- **Firestoreフィールド**：`camelCase`（ID系は `〜Id` で統一）

### 1.3 関数設計の制限ルール
- **単一責任の原則**：1関数＝1責務。
- **行数の上限目安**：1関数 **60〜80行以内**（超える場合はヘルパー関数に分割）。
- **ネストの深さ制限**：`if` / `for` は **最大3階層まで**（早期リターン徹底）。
- **厳格な型定義**：`any` 型の使用は原則禁止。

### 1.4 プロジェクト全体の禁止事項（Strict Prohibitions）
1. **平文トークンの保存・ログ出力禁止**：Metaアクセストークンを平文で保存・`console.log`出力することを厳禁とする。
2. **クライアントからのトークン直接アクセス禁止**：ブラウザから `metaConnection.encryptedAccessToken` を読み書きしない。
3. **無制限ループ・タイムアウト無視の禁止**：外部API・AI生成には必ずリトライ上限とタイムアウトを設定する。
4. **ガードレール未チェックでの配信禁止**：`dailySpendCap` およびLP死活チェックを通過せずに広告を `ACTIVE` にしない。
5. **Advantage+ クリエイティブの無断有効化禁止**：入稿時 `degrees_of_freedom_spec` でテキスト自動改変を必ず `OPT_OUT` にする。
6. **モデルIDのハードコード禁止**：機能ファイル内に `"gemini-2.5-pro"` 等を直接書かず、必ず `utils/aiRouter.ts` を経由して呼び出す。

### 1.5 ルールの機械的強制（ハーネス）
上記 1.3・1.4 は `scripts/harness/` で機械チェックされ、Claude Code フック・git フック・CI のすべてで同じ判定が走る。外部HTTPは `utils/fetchWithTimeout.ts`、ACTIVE 化は `utils/guardrailGate.ts` の `assertCanActivate()` を必ず経由する。設計は `docs/HARNESS.md`、GitHub 連携とインシデント防止のルールは `docs/GITHUB_RULES.md` を参照。

---

## 第2章：ガードレール目標・KPI基準
- **LP死活監視応答**：HTTP `200〜299` かつ 10秒以内応答（違反時は全キャンペーン即 `PAUSED`）
- **学習期間保護**：最低 `1,000インプレッション` 到達までAI自動損切りを待機
- **損切り判定ライン**：CVゼロで `目標CPA × 1.5倍` 消化、または `CPA > 目標×1.3 かつ ROAS < 最低ROAS`
- **Critic合格スコア**：**80点以上（100点満点）** かつ ポリシー違反ゼロ
- **監視バッチ周期**：8時間ごと（0:00 / 8:00 / 16:00 JST）
- **AIモデル自動最適化**：週次で新モデルと価格を調査し、ベンチマーク合格＆コスパ向上時のみ本番モデルを自動昇格

---

## 第3章：環境構築・デプロイコマンド
```bash
# 1. Secret Manager へのシークレット登録
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set META_APP_ID
firebase functions:secrets:set META_APP_SECRET
firebase functions:secrets:set META_LIBRARY_ACCESS_TOKEN
firebase functions:secrets:set STRIPE_SECRET_KEY
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
firebase functions:secrets:set TOKEN_ENCRYPTION_KEY

# 2. Functions ビルド＆デプロイ
cd functions && npm install && npm run build && cd ..
firebase deploy --only firestore:rules,storage,functions
```
