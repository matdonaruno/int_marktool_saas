#!/usr/bin/env node
// Claude Code SessionStart フック:
//  1. git フック (.githooks) を有効化する（クラウドセッションは毎回 fresh clone のため）
//  2. 現在のブランチと要点ルールをコンテキストに注入する（stdout がセッションに入る）
import { execFileSync } from "node:child_process";
import { isProtectedBranch } from "../lib/gitPolicy.mjs";

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const git = (...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

let branch = "(unknown)";
try {
  git("config", "core.hooksPath", ".githooks");
  branch = git("rev-parse", "--abbrev-ref", "HEAD");
} catch {
  // git 管理外
}

const lines = [
  "## ハーネス（自動注入）",
  `- 現在のブランチ: ${branch}${isProtectedBranch(branch) ? "  ⚠ 保護ブランチ。作業前に git switch -c <type>/<topic> で作業ブランチを切ること" : ""}`,
  "- git フック (.githooks) を有効化済み: pre-commit=ルールチェック / pre-push=保護ブランチ・force push 拒否 + 全体チェック",
  "- 着手前に CLAUDE.md → MASTER_SPEC.md 第1章 → docs/GITHUB_RULES.md を確認する",
  "- 完了条件: `npm run harness:verify` が通ること（ルール + lint + 型 + functions build + テスト）",
  "- AI がやらないこと: main への push / force push / PR マージ / firebase deploy / シークレット操作 / .env の閲覧",
];
process.stdout.write(lines.join("\n") + "\n");
