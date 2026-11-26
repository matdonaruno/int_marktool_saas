#!/usr/bin/env node
// Claude Code Stop フック: 応答を終える前に、変更ファイルへルールチェックをかける。
// 違反があれば exit 2 で Claude に差し戻す（stop_hook_active のときは無限ループ防止のため通す）。
import { execFileSync } from "node:child_process";
import { readHookInput } from "./hookIo.mjs";

const input = await readHookInput();
if (input.stop_hook_active) process.exit(0);

const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
try {
  execFileSync("node", ["scripts/harness/check-rules.mjs", "--changed"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.exit(0);
} catch (err) {
  const out = `${err.stdout || ""}${err.stderr || ""}`.trim();
  if (!out) process.exit(0); // git 管理外などチェック自体が動かない場合は止めない
  process.stderr.write(
    `作業ツリーの変更にハーネス違反があります。直してから終了してください:\n${out}\n`
  );
  process.exit(2);
}
