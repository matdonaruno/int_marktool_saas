#!/usr/bin/env node
// Claude Code PreToolUse(Write|Edit|MultiEdit) フック。
// 編集「後」の内容を組み立てて scripts/harness/lib/rules.mjs を適用し、
// この編集で新たに生まれる error だけをブロックする（既存の違反で無関係な編集を止めない）。
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { checkFile, formatViolation, violationKey } from "../lib/rules.mjs";
import { readHookInput, toRepoPath } from "./hookIo.mjs";

const input = await readHookInput();
const ti = input?.tool_input || {};
const filePath = ti.file_path;
if (!filePath) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const absPath = isAbsolute(filePath) ? filePath : join(projectDir, filePath);
const repoPath = toRepoPath(absPath, projectDir);
if (repoPath.startsWith("/") || repoPath.startsWith("..")) process.exit(0); // リポジトリ外は対象外

const before = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";

function applyEdit(text, { old_string: oldStr, new_string: newStr, replace_all: all }) {
  if (typeof oldStr !== "string" || typeof newStr !== "string") return text;
  return all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
}

let after = before;
if (input.tool_name === "Write") after = String(ti.content ?? "");
else if (input.tool_name === "Edit") after = applyEdit(before, ti);
else if (input.tool_name === "MultiEdit") after = (ti.edits || []).reduce(applyEdit, before);

const existing = new Set(checkFile(repoPath, before).map((v) => violationKey(v, before)));
const introduced = checkFile(repoPath, after).filter(
  (v) => v.severity === "error" && !existing.has(violationKey(v, after))
);
if (introduced.length === 0) process.exit(0);

process.stderr.write(
  [
    "⛔ この編集はハーネスのルールに違反するためブロックしました:",
    ...introduced.map((v) => "  " + formatViolation(repoPath, v)),
    "ルールの根拠: MASTER_SPEC.md 第1章 / docs/HARNESS.md / docs/GITHUB_RULES.md",
  ].join("\n") + "\n"
);
process.exit(2);
