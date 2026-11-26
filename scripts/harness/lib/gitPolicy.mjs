// GitHub 連携ルール（docs/GITHUB_RULES.md）のうち、コマンド文字列で判定できるものの定義。
// Claude Code の PreToolUse(Bash) フックと git pre-push フックが共有する。

export const PROTECTED_BRANCHES = ["main", "master", "production", "release"];

const protectedRe = new RegExp(`^(refs/heads/)?(${PROTECTED_BRANCHES.join("|")})$`);
export const isProtectedBranch = (name) => protectedRe.test(String(name || "").trim());

/**
 * シェルコマンドを && || ; | 改行 で大まかに分割する（クォート内は分割しない）。
 * 完全なシェルパーサではない。フックは多層防御の1層であり、CI・ブランチ保護が後段にいる前提。
 */
export function splitCommands(command) {
  const parts = [];
  let buf = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      buf += c;
      if (c === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; buf += c; continue; }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") { parts.push(buf); buf = ""; i++; continue; }
    if (c === ";" || c === "|" || c === "\n") { parts.push(buf); buf = ""; continue; }
    buf += c;
  }
  parts.push(buf);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const tokens = (seg) => seg.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) || [];

/** `git -C dir push` のような前置オプションを飛ばして git サブコマンドを返す */
function gitSub(tok) {
  const gi = tok.findIndex((t) => t === "git" || t.endsWith("/git"));
  if (gi < 0) return null;
  let i = gi + 1;
  while (i < tok.length && tok[i].startsWith("-")) i += tok[i] === "-C" || tok[i] === "-c" ? 2 : 1;
  return { sub: tok[i], args: tok.slice(i + 1) };
}

/**
 * 1セグメントを判定して、ブロック理由（なければ null）を返す。
 * @param {string} seg
 * @param {{ currentBranch?: string }} ctx
 */
export function checkSegment(seg, ctx = {}) {
  const tok = tokens(seg);
  const g = gitSub(tok);

  if (g) {
    const { sub, args } = g;
    if (args.includes("--no-verify") || (sub === "commit" && args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a)))) {
      return "G7: --no-verify / commit -n でフックを迂回しない。フックが落ちた原因を直すこと";
    }
    if (sub === "push") {
      if (args.some((a) => /^(--force|--force-with-lease|--force-if-includes|-f)(=.*)?$/.test(a) || /^-[a-zA-Z]*f/.test(a) && !a.startsWith("--"))) {
        return "G2: force push 禁止。履歴を書き換えず、追加コミットで直すこと";
      }
      const refspecs = args.filter((a) => !a.startsWith("-")).slice(1);
      if (refspecs.some((r) => r.startsWith("+"))) return "G2: +refspec による強制 push 禁止";
      if (args.includes("--delete") || args.includes("-d") || refspecs.some((r) => r.startsWith(":"))) {
        return "G4: リモートブランチ削除は人間が行う（先に archive/<name> タグを push すること）";
      }
      if (args.includes("--mirror") || args.includes("--all")) return "G1: --mirror / --all push 禁止";
      const dests = refspecs.map((r) => r.split(":").pop());
      if (dests.some(isProtectedBranch)) return `G1: 保護ブランチ (${PROTECTED_BRANCHES.join("/")}) へ直接 push しない。作業ブランチ → PR`;
      if (refspecs.length === 0 && isProtectedBranch(ctx.currentBranch)) {
        return `G1: 現在のブランチ ${ctx.currentBranch} から push しようとしている。作業ブランチを切ること`;
      }
    }
    if (sub === "commit" && isProtectedBranch(ctx.currentBranch)) {
      return `G1: 保護ブランチ ${ctx.currentBranch} 上で直接コミットしない。git switch -c <作業ブランチ> してから`;
    }
    if (sub === "add" && args.some((a) => a === "-A" || a === "--all" || a === "." || a === ":/")) {
      return "G5: git add -A / . は禁止。意図したファイルだけをパス指定で add する（.env 等の混入防止）";
    }
    if (sub === "reset" && args.includes("--hard")) return "G6: git reset --hard は人間の明示指示があるときのみ（未コミット作業の消失防止）";
    if (sub === "clean" && args.some((a) => /^-[a-zA-Z]*f/.test(a))) return "G6: git clean -f は人間の明示指示があるときのみ";
    if (sub === "branch" && args.some((a) => a === "-D" || a === "--delete" && args.includes("--force"))) {
      return "G4: git branch -D は禁止。マージ済みなら -d、未マージなら archive/ タグを打ってから人間が判断";
    }
    if (sub === "rebase" && isProtectedBranch(ctx.currentBranch)) return "G2: 保護ブランチ上で rebase しない";
    if (sub === "filter-branch" || sub === "filter-repo") return "G2: 履歴書き換えツール禁止";
    const hpIdx = args.findIndex((a) => /^core\.hooksPath$/i.test(a));
    const hpValue = hpIdx >= 0 ? args[hpIdx + 1] : undefined;
    const isUnset = args.some((a) => /^--unset/.test(a));
    if (sub === "config" && hpIdx >= 0 && (isUnset || (hpValue !== undefined && hpValue !== ".githooks"))) {
      return "G7: core.hooksPath を .githooks 以外に変えない（ローカルフックの無効化防止）";
    }
  }

  const ghIdx = tok.indexOf("gh");
  if (ghIdx >= 0) {
    const [a, b] = tok.slice(ghIdx + 1);
    if (a === "pr" && b === "merge") return "G8: PR のマージは人間が行う（AI はドラフト PR 作成まで）";
    if (a === "repo" && (b === "delete" || b === "edit" || b === "rename")) return "G8: リポジトリ設定の変更は人間が行う";
    if (a === "secret" || a === "variable") return "G5: GitHub Secrets/Variables の操作は人間が行う";
    if (a === "workflow" && (b === "disable" || b === "enable")) return "G9: ワークフローの有効/無効は人間が行う";
    if (a === "api" && tok.some((t) => /^(-X|--method)$/.test(t)) && tok.some((t) => /^(DELETE|PUT|PATCH)$/i.test(t))) {
      return "G8: gh api による書き込み系操作はしない";
    }
  }

  const fbIdx = tok.findIndex((t) => t === "firebase" || t.endsWith("/firebase"));
  if (fbIdx >= 0) {
    const sub = tok[fbIdx + 1] || "";
    if (/^(deploy|hosting:channel:deploy|functions:delete|firestore:delete|database:remove|projects:|use$)/.test(sub) || /^functions:secrets:(set|destroy|prune)/.test(sub)) {
      return `G10: firebase ${sub} は本番に作用する。デプロイ・シークレット操作は人間が MASTER_SPEC 第3章の手順で行う`;
    }
  }
  if (tok[0] === "gcloud" && tok.some((t) => /^(delete|deploy|set-iam-policy|add-iam-policy-binding)$/.test(t))) {
    return "G10: gcloud による本番リソース変更は人間が行う";
  }

  const readsEnv = tok.some((t) => /(^|\/)\.env(\.[\w.-]+)?$/.test(t) && !/\.example$/.test(t));
  if (readsEnv && /^(cat|less|more|head|tail|grep|rg|sed|awk|cp|mv|source|\.|bat|xxd|strings|base64|curl)$/.test(tok[0] || "")) {
    return "G5: .env 系ファイルの中身を読まない/持ち出さない（.env.local.example を参照）";
  }
  return checkSafety(tok, ctx);
}

// --- 安全ルール（dev-notes operations/claude-code-safety-rules.md / permissions-design.md の deny 系） ---

/** `VAR=x cmd` の前置代入を外したトークン列 */
const stripAssignments = (tok) => {
  let i = 0;
  while (i < tok.length && /^[A-Za-z_]\w*=/.test(tok[i])) i++;
  return tok.slice(i);
};

/** 変数名 v が同じコマンド内で空チェックされているか（[ -n "$V" ] / ${V:?} / test -n） */
const isAsserted = (v, full = "") =>
  new RegExp(`(-n\\s+["']?\\$\\{?${v}\\}?|\\$\\{${v}:\\?)`).test(full);

function checkSafety(rawTok, ctx) {
  const tok = stripAssignments(rawTok);
  const cmd = tok[0];
  // `gsutil -m rsync` / `rclone -v copy` のような前置グローバルフラグを飛ばしてサブコマンドを取る
  const [a1, a2] = /^(rclone|aws|gsutil|gcloud|az|supabase|doppler)$/.test(cmd || "")
    ? tok.slice(1).filter((t) => !t.startsWith("-"))
    : tok.slice(1);
  const full = ctx.fullCommand || tok.join(" ");

  if (cmd === "sudo" || (cmd === "su" && a1 === "-")) return "S1: sudo / su - は使わない";
  if (cmd === "chmod" && tok.includes("-R") && tok.includes("777")) return "S1: chmod -R 777 禁止";
  if (cmd === "chown" && tok.includes("-R")) return "S1: chown -R 禁止";

  if (cmd === "rm" && tok.some((t) => /^-[a-zA-Z]*[rR]/.test(t))) {
    const targets = tok.slice(1).filter((t) => !t.startsWith("-"));
    if (targets.some((t) => /^(\/\*?|~\/?|\$HOME\/?|\$\{HOME\}\/?|\.git\/?|\.\/?|\*|\.\.\/?)$/.test(t))) {
      return "S1: /・$HOME・~・.git・カレント全体への rm -r は禁止";
    }
    const unchecked = targets
      .flatMap((t) => [...t.matchAll(/\$\{?([A-Za-z_]\w*)/g)].map((m) => m[1]))
      .filter((v) => !isAsserted(v, full));
    if (unchecked.length) {
      return `S1: rm -r の引数に未検証の変数 ($${unchecked.join(", $")}) がある。空文字だと / に展開される。同じコマンド内で [ -n "$VAR" ] && [ "$VAR" != "/" ] を assert するか、パスを直接書くこと`;
    }
  }

  if (cmd === "rclone" && /^(sync|copy|copyto|move|moveto|delete|deletefile|purge|rmdirs)$/.test(a1 || "")) {
    return "S4: rclone の転送・削除はユーザーが実行する（空変数事故の系統。SRC/DEST を echo し、1ファイル smoke test から）";
  }
  if (cmd === "aws" && a1 === "s3" && /^(sync|rm|mv|cp)$/.test(a2 || "")) return "S4: aws s3 の転送・削除はユーザーが実行する";
  if (cmd === "gsutil" && /^(rsync|rm|mv|cp)$/.test(a1 || "")) return "S4: gsutil の転送・削除はユーザーが実行する（Firebase Storage バケットを含む）";
  if (cmd === "gcloud" && a1 === "storage" && /^(cp|rsync|rm|mv)$/.test(a2 || "")) return "S4: gcloud storage の転送・削除はユーザーが実行する";
  if (cmd === "az" && a1 === "group" && a2 === "delete") return "S4: az group delete 禁止";

  if (cmd === "supabase" && (a1 === "reset" || (a1 === "db" && a2 === "reset"))) return "S1: supabase reset 禁止";
  if (cmd === "dropdb") return "S1: dropdb 禁止";
  if (cmd === "psql" && /\b(DROP|TRUNCATE)\b/i.test(full)) return "S1: psql での DROP / TRUNCATE 禁止";
  if (cmd === "doppler" && ((a1 === "secrets" && /^(set|unset|delete)$/.test(a2 || "")) || (/^(projects|configs)$/.test(a1 || "") && a2 === "delete"))) {
    return "S5: doppler のシークレット変更・削除はユーザーが行う";
  }
  if (rawTok.includes("update-ref") && rawTok.includes("-d")) return "G2: git update-ref -d 禁止";
  return null;
}

/** コマンド全体を判定し、ブロック理由の配列を返す */
export function checkCommand(command, ctx = {}) {
  const full = { ...ctx, fullCommand: command };
  return splitCommands(command).map((s) => checkSegment(s, full)).filter(Boolean);
}
