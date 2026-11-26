## 変更内容

<!-- 何を・なぜ。1 PR = 1 目的（docs/GITHUB_RULES.md G3） -->

## 検証

<!-- 実際に実行したコマンドと結果。「動くはず」は不可（安全ルール6: 検証なしの完了宣言禁止） -->

- [ ] `npm run harness:verify` がローカルで通った
- [ ] CI（harness / web / functions）が緑

## MASTER_SPEC 第1章チェック

- [ ] 既存の `functions/src/utils/` / `types/` を確認し、重複実装していない（1.1）
- [ ] 1関数 80 行以内・ネスト 3 階層以内・`any` なし（1.3）
- [ ] トークンを平文保存・ログ出力していない / クライアントから触れていない（1.4-1, 1.4-2）
- [ ] 外部 API に `fetchWithTimeout` + リトライ上限（1.4-3）
- [ ] `ACTIVE` にする経路は `assertCanActivate()` を通る（1.4-4）
- [ ] モデル ID は `aiRouter` 経由（1.4-6）

## 本番影響・ロールバック

<!-- Firestore スキーマ / Security Rules / Secret / スケジュール関数 / Meta 入稿・課金に触れるか。
     触れるなら、デプロイ手順（人間が実行）と戻し方を書く（G10） -->

- [ ] 本番影響なし
- [ ] 本番影響あり → デプロイ手順・ロールバック手順を上に記載
