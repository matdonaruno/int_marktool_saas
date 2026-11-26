# GitHub 連携ルール & インシデント防止ルール

Claude Code（ローカル / クラウド）と人間がこのリポジトリを GitHub と連携して扱うときのルール。
**このリポジトリは public。** コミットした瞬間に全世界へ公開される前提で扱う。

- 正本（横断ルール）: `dev-notes/operations/claude-code-safety-rules.md`、`~/.claude/permissions-design.md`、`~/.claude/CLAUDE.md`
- 本書はそれをこのプロジェクト（Next.js + Firebase + Meta/Stripe/Gemini）に当てはめたもの。
- 各ルールの機械的な強制箇所は `docs/HARNESS.md` §3 の対応表を参照。

## 1. GitHub 運用ルール（G）

| ID | ルール | 理由 |
|---|---|---|
| **G1** | `main`（および master/production/release）へ直接 commit・push しない。必ず作業ブランチ → **ドラフト PR**。 | main は本番デプロイの起点。レビューと CI を必ず通す。 |
| **G2** | force push・`--force-with-lease`・`+refspec`・`filter-repo`・`update-ref -d` をしない。直すときは追加コミット。リモートに先行コミットがあれば `git fetch && git merge` してから push。 | 履歴を消すと他セッション・他人の作業が消える。 |
| **G3** | **1 PR = 1 ブランチ = 1 目的。ブランチを使い回さない。** squash merge 後は同じブランチで作業を続けず、main から新しく切る。命名: `feat/` `fix/` `docs/` `chore/` `claude/`。 | squash merge 後に同じブランチを使い回すと祖先関係が切れ、同一内容でもコンフリクトが連鎖する（他プロジェクトで実発生）。 |
| **G4** | ブランチを消す前に `archive/<name>` の軽量タグを push する。リモートブランチ削除は人間が GitHub 上で行う。AI は `branch -D` しない。 | 参照の切れたコミットは GitHub の gc で復元不能になる。 |
| **G5** | シークレット・機密ファイルをコミットしない（`.env*`、サービスアカウント JSON、`*.pem/*.p8/*.p12`、`AuthKey_*`、`*credentials*`、`memo*.txt`、`.claude/settings.local.json`）。`git add -A` / `git add .` を使わずパス指定で add する。シークレットは **Firebase Secret Manager** と **GitHub Secrets** にのみ置く。 | public リポジトリ。一度 push したら「漏れた」扱いで即ローテーション。 |
| **G6** | `git reset --hard` / `git clean -f` / `git checkout -- .` は人間の明示指示があるときだけ。 | 未コミット作業の消失。 |
| **G7** | フックを迂回しない（`--no-verify`、`commit -n`、`core.hooksPath` の変更・解除）。フックが落ちたら原因を直す。 | ハーネスの無効化。 |
| **G8** | **PR のマージ・auto-merge・リポジトリ設定変更・Secrets 操作は人間が行う。** AI はドラフト PR の作成まで。GitHub MCP の `push_files` / `create_or_update_file` / `delete_file` は使わない（ローカルフックを素通りして直接コミットされるため）。 | 外向きの最終判断は人間。 |
| **G9** | CI（harness / web / functions）が緑でない PR はマージしない。テストを skip・削除して緑にしない。ワークフローの有効/無効は人間。 | |
| **G10** | `firebase deploy`、`functions:secrets:set/destroy`、`firestore:delete`、gcloud の本番変更は **人間が** MASTER_SPEC 第3章の手順で行う。PR に本番影響とロールバック手順を書く。 | 広告配信・課金に直結する。誤配信は実費が出る。 |
| **G11** | GitHub Actions は `permissions: contents: read` を基本にし、`pull_request_target` を使わない。Secrets を使うジョブを追加するときは人間がレビューする。 | public リポジトリへのフォーク PR から Secrets を抜かれる典型経路。 |

## 2. インシデント防止ルール（S）— 横断安全ルールのこのプロジェクトへの適用

| ID | 横断ルール | このプロジェクトでの具体化 |
|---|---|---|
| **S1** | Destructive Command Safety: 空変数・`/`・`$HOME` を破壊系コマンドの引数にしない。実行前に assert + echo。 | `rm -r` の引数に変数を使うなら同じコマンド内で `[ -n "$VAR" ] && [ "$VAR" != "/" ]` か `${VAR:?}`。`sudo`・`chmod -R 777`・`chown -R`・DB reset/DROP は AI 実行禁止。 |
| **S2** | macOS / Linux の方言を意識する。 | ハーネスのスクリプトは Node（`.mjs`）と POSIX sh で書き、`sed -i`・`du -b`・`date -d`・`readlink -f` を使わない。一括置換は Python の `str.replace` + 事前・事後 `grep -rn` で件数確認。 |
| **S3** | バックグラウンドプロセスは PID を記録し、終了時に `ps` で確認。異常時は kill が最優先。 | `firebase emulators:start` / `next dev` を裏で起動したら、終了時に `ps -ef \| grep -E "firebase\|next"` で残存確認。 |
| **S4** | クラウドアップロードは SRC/DEST を echo、初回 1 ファイル smoke test。公開設定は中身を確認してから。 | Firebase Storage（`gsutil`・`gcloud storage`）・R2・S3 への転送/削除は**ユーザーが実行**。`storage.rules` / `firestore.rules` に `if true` を入れない（ハーネスが検出）。 |
| **S5** | Secrets Awareness: 機密ディレクトリ・ファイルを上げない。漏れたら public OFF → revoke → 削除 → audit → 記録。 | G5 と同じ。漏洩時はコミットを消すより先に **キーのローテーション**（Meta App Secret / Stripe / Gemini / TOKEN_ENCRYPTION_KEY）。履歴の書き換えは人間が判断。 |
| **S6** | Verification Before Trust: 検証なしの「完了」宣言禁止。 | 完了条件は `npm run harness:verify` の成功 + CI 緑。PR の「検証」欄に実行したコマンドと結果を書く。 |
| **S7** | 異常時の順序: kill → cleanup → revoke → audit → verify → document。 | インシデントは `dev-notes/operations/incidents/YYYY-MM-DD-<slug>.md` に記録し、再発防止を本書とハーネスのルールに反映する。 |

## 3. GitHub 側で人間が設定すること（L5）

ハーネスはローカルと CI までしか強制できない。以下は **リポジトリ Settings で人間が一度だけ設定**する。

- [ ] **Branch protection / Ruleset（`main`）**
  - Require a pull request before merging（承認 1 以上）
  - Require status checks: `harness (rules + tests)` / `web (lint + typecheck)` / `functions (build)`
  - Block force pushes / Restrict deletions
  - Do not allow bypassing the above settings
- [ ] **Code security**: Secret scanning と **Push protection** を ON（public リポジトリは無料）
- [ ] **General**: Allow squash merging のみ ON、**Automatically delete head branches** は OFF（G4 の archive タグ運用のため）
- [ ] **Actions**: Workflow permissions を "Read repository contents" に、"Allow GitHub Actions to create and approve pull requests" を OFF

## 4. AI セッションの標準フロー

1. セッション開始 → SessionStart フックが git フックを有効化し、現在ブランチを表示。
2. 保護ブランチ上なら `git switch -c <type>/<topic>`。
3. 実装 → 編集フックが MASTER_SPEC 違反をその場で差し戻す。
4. `npm run harness:verify` → 意図したファイルだけ `git add <path>` → commit（確認あり）。
5. `git push -u origin <branch>`（確認あり。pre-push が最終検査）→ **ドラフト PR** を作成。
6. CI 緑を確認 → 人間がレビュー・マージ・デプロイ。
