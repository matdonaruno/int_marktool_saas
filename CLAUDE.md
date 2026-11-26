# CLAUDE.md — AI Ad Autopilot SaaS

毎回守らないと事故になる結論だけを置く。詳細は `MASTER_SPEC.md`（仕様・開発規約）、`docs/HARNESS.md`（ハーネス設計）、`docs/GITHUB_RULES.md`（GitHub 連携とインシデント防止）。

## 着手前
- `MASTER_SPEC.md` 第1章を守る。新規ロジックの前に `functions/src/utils/` と `types/` に同じものがないか確認する。
- 保護ブランチ（main 等）上なら作業ブランチを切る。**1 PR = 1 ブランチ。使い回さない。**

## 🔴 AI がやらないこと（ハーネスがブロックする。必要ならユーザーに依頼）
- main への push・force push・履歴書き換え・ブランチ削除・PR マージ・GitHub 設定/Secrets 操作
- `firebase deploy`・`functions:secrets:*`・本番データ削除・クラウドストレージの一括転送/削除
- `.env*` やサービスアカウント鍵を読む・コミットする。`git add -A` / `git add .`
- `--no-verify` などでフックを迂回する。`.claude/settings.json`・`.githooks/` を書き換える
- 未検証の変数・`/`・`$HOME` を `rm -r` に渡す（使うなら同じコマンドで `[ -n "$VAR" ]` を assert）

## コードの禁止事項（機械チェックあり: `npm run harness:check`）
- 外部 HTTP は `utils/fetchWithTimeout.ts`、`ACTIVE` 化は `utils/guardrailGate.ts` の `assertCanActivate()`、モデルは `utils/aiRouter.ts` 経由
- トークンを console に出さない。クライアントから `encryptedAccessToken` に触れない。`any` を使わない
- adcreatives は `degrees_of_freedom_spec` で `OPT_OUT`。Security Rules に `if true` を書かない

## 判断 API（Cloud Run）
- 外部アプリ向けの判断 API は `functions/src/decisionApi/`（仕様・ループ設計・デプロイは `docs/DECISION_API.md`）。プロンプトを変えたら `*_PROMPT_VERSION` を上げる。

## 完了条件
- `npm run harness:verify` が通るまで「完了」と言わない。裏で起動したプロセス（emulator / next dev）は終了時に `ps` で残っていないか確認する。
- ブロックされたら、メッセージのルール ID と根拠を読んで直す。ルール自体がおかしいと思ったらユーザーに相談する（自分で緩めない）。
