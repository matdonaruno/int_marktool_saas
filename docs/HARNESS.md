# ハーネス設計（AI 開発の安全装置）

このリポジトリで Claude Code（と人間）が開発するときの「ルールを書いて終わり」にしないための仕組み。
**permission は構造の堰、CLAUDE.md は振る舞いの躾。両方を重ねて初めて安全に自律実行できる。**
（出典: 横断安全ルール `dev-notes/operations/claude-code-safety-rules.md` / `~/.claude/permissions-design.md`）

## 1. 設計方針

1. **ルールは1か所に書き、全レイヤーが同じ実装を呼ぶ。**
   判定ロジックは `scripts/harness/lib/rules.mjs`（ファイル内容）と `scripts/harness/lib/gitPolicy.mjs`（コマンド）だけ。
   Claude フック・git フック・CI はこの2つを import するだけなので、レイヤー間でルールがずれない。
2. **多層防御。** どの層も単独では完璧でない（シェルの字句解析は近似、フックは `--no-verify` で外せる等）。
   前の層を抜けても次の層で止まるように重ねる。最後の砦は GitHub のブランチ保護（人間が設定）。
3. **既存違反で無関係な作業を止めない。** 編集フックは「この編集で新たに増えた違反」だけを止める。
   全体の違反は pre-push / CI で止める。
4. **止めたら理由と直し方を返す。** ブロック時のメッセージにはルール ID・根拠・代替手段を必ず入れる。
   AI はそれを読んで自分で直す（フィードバックループ）。
5. **ハーネス自身もテストする。** ルールの追加・修正は `scripts/harness/*.test.mjs` に正例・反例を足す。CI で回る。
6. **AI にハーネスを弱めさせない。** `.claude/settings.json`・`.githooks/**` は AI から Edit 拒否。
   変更するときは人間が行う（または人間の明示指示のもとで行う）。

## 2. レイヤー構成

```
 L0 躾        CLAUDE.md（結論だけ）→ MASTER_SPEC.md 第1章 → docs/GITHUB_RULES.md
 ────────────────────────────────────────────────────────────────────────────
 L1 permission .claude/settings.json  allow(参照・検証) / ask(commit・push・install・rm・sed -i) / deny(破壊系)
 ────────────────────────────────────────────────────────────────────────────
 L2 Claude    SessionStart  → git フック有効化 + 現在ブランチと要点をコンテキストに注入
    フック    PreToolUse    → Bash: gitPolicy で G1〜G11 / S1〜S5 違反コマンドを実行前にブロック
                            → Write|Edit|MultiEdit: 編集後の内容を rules で検査、新規違反をブロック
              Stop          → 作業ツリーの変更ファイルを検査、違反があれば差し戻す
 ────────────────────────────────────────────────────────────────────────────
 L3 git       pre-commit    → 保護ブランチでのコミット拒否 + ステージ内容を rules で検査
    フック    pre-push      → 保護ブランチ push / 非 fast-forward / ブランチ削除を拒否 + 全体検査
              （人間の手作業にも効く。`npm run harness:install` で有効化）
 ────────────────────────────────────────────────────────────────────────────
 L4 CI        .github/workflows/ci.yml  harness / web / functions の3ジョブ（permissions: read のみ）
 ────────────────────────────────────────────────────────────────────────────
 L5 GitHub    ブランチ保護・Secret scanning push protection（人間が Settings で設定。GITHUB_RULES.md §3）
```

## 3. ルール ⇔ 強制レイヤー対応表

| ルール | 内容 | L1 | L2 | L3 | L4 | 備考 |
|---|---|:-:|:-:|:-:|:-:|---|
| SPEC-1.4.1 | トークンの console 出力禁止 | | ✅ | ✅ | ✅ | |
| SPEC-1.4.2 | クライアントから `encryptedAccessToken` に触れない | | ✅ | ✅ | ✅ | firestore.rules でも拒否 |
| SPEC-1.4.3 | 外部 HTTP は `fetchWithTimeout` 経由 | | ✅ | ✅ | ✅ | リトライ上限はレビュー |
| SPEC-1.4.4 | `ACTIVE` 化は `assertCanActivate()` 必須 | | ✅ | ✅ | ✅ | dailySpendCap + LP 死活 |
| SPEC-1.4.5 | adcreatives は Advantage+ `OPT_OUT` | | ✅ | ✅ | ✅ | |
| SPEC-1.4.6 | モデル ID 直書き禁止（aiRouter 経由） | | ✅ | ✅ | ✅ | |
| SPEC-1.3 | `any` 禁止 | | ✅ | ✅ | ✅ | 行数・ネストはレビュー |
| G1 | 保護ブランチへ直接 commit / push しない | ✅ | ✅ | ✅ | | L5 ブランチ保護 |
| G2 | force push・履歴書き換え禁止 | ✅ | ✅ | ✅ | | L5 で force push 禁止 |
| G4 | ブランチ削除は archive タグ後に人間 | ✅ | ✅ | ✅ | | |
| G5 | シークレット・機密ファイルをコミットしない | ✅ | ✅ | ✅ | ✅ | L5 push protection |
| G6 | `reset --hard` / `clean -f` は人間の指示時のみ | ✅ | ✅ | | | |
| G7 | フック迂回（`--no-verify`・hooksPath 変更）禁止 | ✅ | ✅ | | ✅ | CI が後段で必ず回る |
| G8 | PR マージ・リポジトリ設定は人間 | ✅ | ✅ | | | |
| G10 | デプロイ・Secret Manager 操作は人間 | ✅ | ✅ | | | |
| S1 | 未検証変数・`/`・`$HOME` への `rm -r`、sudo 等 | ✅ | ✅ | | | |
| S4 | クラウドストレージ一括転送・削除はユーザー | ✅ | ✅ | | | |
| S4 | Security Rules を `if true` にしない | | ✅ | ✅ | ✅ | |
| S6 | 検証なしの完了宣言禁止 | | ✅ | | ✅ | Stop フック + `harness:verify` |

L1 の ✅ は `.claude/settings.json` の deny/ask。L2〜L4 は同じ判定コード。

## 4. 使い方

```bash
npm run harness:install   # git フックを有効化（クローン直後に1回。Claude Code は SessionStart で自動実行）
npm run harness:check     # ルール検査（全ファイル）
npm run harness:test      # ハーネス自身のテスト
npm run harness:verify    # 完了条件: ルール + テスト + lint + 型 + functions build
```

## 5. ルールを追加・変更するとき

1. 判定を `scripts/harness/lib/rules.mjs`（内容）か `gitPolicy.mjs`（コマンド）に足す。ID は `SPEC-x.y` / `G<n>` / `S<n>`。
2. 正例（止める）と反例（止めない＝誤検知しない）を `*.test.mjs` に足す。
3. 根拠を `docs/GITHUB_RULES.md` か MASTER_SPEC に1行書き、本ファイルの対応表を更新する。
4. `npm run harness:verify` → PR。ハーネス変更の PR は人間がレビューしてマージする。

## 6. 既知の限界（意図的に機械化していないもの）

- **シェル解析は近似。** `eval`・変数に入れたコマンド・別スクリプト経由は見抜けない。後段（L3〜L5）で拾う前提。
- **関数 80 行・ネスト 3 階層（MASTER_SPEC 1.3）** は誤検知が多いため機械化せず、PR テンプレのチェック項目にしている。
- **バックグラウンドプロセスの後始末・事後検証（安全ルール3・6・7）** は振る舞いのルール。CLAUDE.md に結論を置き、
  完了条件として `harness:verify` を必須にしている。
- **クラウド（Claude Code on the web）セッション**では `~/.claude/` のグローバル設定は読まれない。
  このリポジトリに入れたプロジェクト設定（`.claude/settings.json`）だけが効くので、必要な deny はここに重ねてある。
