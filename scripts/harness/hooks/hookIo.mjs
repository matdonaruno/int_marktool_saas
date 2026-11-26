// Claude Code フック共通: stdin の JSON を読む
export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** フックの cwd からリポジトリ相対パスへ変換する */
export function toRepoPath(filePath, projectDir) {
  const base = (projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/\/$/, "");
  const p = String(filePath || "").replace(/\\/g, "/");
  return p.startsWith(base + "/") ? p.slice(base.length + 1) : p.replace(/^\.\//, "");
}
