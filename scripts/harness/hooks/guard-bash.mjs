#!/usr/bin/env node
// Claude Code PreToolUse(Bash) フック。
// docs/GITHUB_RULES.md の G1〜G10 に反するコマンドを実行前にブロックする（exit 2 = ブロック、stderr が Claude に返る）。
import { execFileSync } from "node:child_process";
import { checkCommand } from "../lib/gitPolicy.mjs";
import { readHookInput } from "./hookIo.mjs";

const input = await readHookInput();
const command = input?.tool_input?.command;
if (typeof command !== "string" || !command.trim()) process.exit(0);

let currentBranch = "";
try {
  currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: input.cwd || process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // git 管理外ならブランチ判定は省略
}

const reasons = checkCommand(command, { currentBranch });
if (reasons.length === 0) process.exit(0);

process.stderr.write(
  [
    "⛔ ハーネスがこのコマンドをブロックしました（docs/GITHUB_RULES.md）:",
    ...reasons.map((r) => `  - ${r}`),
    "本当に必要な操作なら、理由を添えてユーザーに依頼し、ユーザー自身に実行してもらうこと。",
  ].join("\n") + "\n"
);
process.exit(2);
