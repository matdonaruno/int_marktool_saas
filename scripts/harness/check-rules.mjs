#!/usr/bin/env node
// ルールチェック CLI。
//   node scripts/harness/check-rules.mjs            … git 管理下 + 未追跡（.gitignore 除く）の全ファイル（CI / pre-push）
//   node scripts/harness/check-rules.mjs --staged   … ステージ済みの内容（pre-commit）
//   node scripts/harness/check-rules.mjs --changed  … 作業ツリーで変更/追加されたファイル（Claude Stop フック）
//   node scripts/harness/check-rules.mjs a.ts b.ts  … 指定ファイル
// error が1件でもあれば exit 1。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { checkFile, formatViolation } from "./lib/rules.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const BINARY = /\.(png|jpe?g|gif|webp|ico|mp4|mov|woff2?|ttf|pdf|zip)$/i;
const SKIP = [/package-lock\.json$/, /^node_modules\//, /^functions\/lib\//];

function targets(argv) {
  if (argv.includes("--staged")) {
    const files = lines(git("diff", "--cached", "--name-only", "--diff-filter=ACMR"));
    return files.map((path) => ({ path, read: () => git("show", `:${path}`) }));
  }
  if (argv.includes("--changed")) {
    const tracked = lines(git("diff", "HEAD", "--name-only", "--diff-filter=ACMR"));
    const untracked = lines(git("ls-files", "--others", "--exclude-standard"));
    return [...new Set([...tracked, ...untracked])].map(fromDisk);
  }
  const explicit = argv.filter((a) => !a.startsWith("--"));
  if (explicit.length) return explicit.map(fromDisk);
  const all = [...lines(git("ls-files")), ...lines(git("ls-files", "--others", "--exclude-standard"))];
  return [...new Set(all)].map(fromDisk);
}

function fromDisk(path) {
  return { path, read: () => (existsSync(path) ? readFileSync(path, "utf8") : "") };
}

function main() {
  const files = targets(process.argv.slice(2)).filter(
    ({ path }) => !BINARY.test(path) && !SKIP.some((re) => re.test(path))
  );
  let errors = 0;
  let warns = 0;
  for (const { path, read } of files) {
    for (const v of checkFile(path, read())) {
      console.error(formatViolation(path, v));
      if (v.severity === "error") errors++;
      else warns++;
    }
  }
  const summary = `harness: ${files.length} files checked, ${errors} error(s), ${warns} warning(s)`;
  if (errors > 0) {
    console.error(`\n${summary}\nルールの根拠と直し方: docs/HARNESS.md / docs/GITHUB_RULES.md`);
    process.exit(1);
  }
  console.log(summary);
}

main();
