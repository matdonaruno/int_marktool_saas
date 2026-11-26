// ハーネス共通ルールエンジン（唯一の正）
// MASTER_SPEC.md 第1章の禁止事項と docs/GITHUB_RULES.md のシークレット規約を
// 「ファイルパス + 内容」に対する機械チェックとして定義する。
// Claude Code フック / git pre-commit / CI がすべてこのファイルを import する。
// ルールを足すときはここに追加し、scripts/harness/rules.test.mjs にテストを足すこと。

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const FUNCTIONS_SRC = /^functions\/src\//;
const APP_SRC = /^(app|types)\//;
const HARNESS_SELF = /^scripts\/harness\//;

/** @typedef {{ ruleId: string, severity: "error" | "warn", line: number, message: string, ref: string }} Violation */

/**
 * 行単位の正規表現ルールを作る。
 * @param {object} def
 * @returns {(path: string, content: string) => Violation[]}
 */
function lineRule({ ruleId, ref, message, pattern, appliesTo, exempt = [], severity = "error" }) {
  return (path, content) => {
    if (!appliesTo(path) || exempt.some((re) => re.test(path))) return [];
    const out = [];
    content.split("\n").forEach((text, i) => {
      if (pattern.test(text)) out.push({ ruleId, severity, line: i + 1, message, ref });
    });
    return out;
  };
}

const isCode = (p) => CODE_EXT.test(p) && !HARNESS_SELF.test(p);
const isFunctionsCode = (p) => FUNCTIONS_SRC.test(p) && isCode(p);
const isClientCode = (p) => APP_SRC.test(p) && isCode(p);

// --- MASTER_SPEC 1.4 / 1.3 ----------------------------------------------------

const noHardcodedModelId = lineRule({
  ruleId: "SPEC-1.4.6/no-hardcoded-model-id",
  ref: "MASTER_SPEC 1.4-6",
  message: "モデルIDを直書きしない。functions/src/utils/aiRouter.ts の getActiveModelRoute() / executeStructuredTextTask() を経由すること",
  pattern: /["'`](gemini|imagen|veo|gpt|claude|o[134])(-[a-z]+)*-[0-9][\w.\-]*["'`]/,
  appliesTo: isCode,
  exempt: [/^functions\/src\/utils\/aiRouter\.ts$/],
});

const noTokenLog = lineRule({
  ruleId: "SPEC-1.4.1/no-token-log",
  ref: "MASTER_SPEC 1.4-1",
  message: "トークン・シークレットを console 出力しない",
  pattern: /console\.(log|info|warn|error|debug)\(.*(token|secret|api_?key|password|accessToken)/i,
  appliesTo: isCode,
});

const noClientTokenAccess = lineRule({
  ruleId: "SPEC-1.4.2/no-client-token-access",
  ref: "MASTER_SPEC 1.4-2",
  message: "クライアント(app/, types/)から encryptedAccessToken に触れない",
  pattern: /encryptedAccessToken/,
  appliesTo: isClientCode,
});

const noRawFetch = lineRule({
  ruleId: "SPEC-1.4.3/fetch-needs-timeout",
  ref: "MASTER_SPEC 1.4-3",
  message: "生の fetch() 禁止。utils/fetchWithTimeout.ts の fetchWithTimeout() を使う（タイムアウト必須）",
  pattern: /(^|[^\w.])fetch\(/,
  appliesTo: isFunctionsCode,
  exempt: [/^functions\/src\/utils\/fetchWithTimeout\.ts$/],
});

const noAnyType = lineRule({
  ruleId: "SPEC-1.3/no-any",
  ref: "MASTER_SPEC 1.3",
  message: "any 型は使わない（unknown + 型ガードにする）",
  pattern: /(:\s*any\b(?!\w)|\bas\s+any\b|<any>|\bany\[\])/,
  appliesTo: (p) => isCode(p) && /\.(ts|tsx)$/.test(p),
});

/** 1.4-4: ACTIVE で入稿・再開するファイルはガードレールゲートを通す */
function activationNeedsGuard(path, content) {
  if (!isFunctionsCode(path) || /utils\/(guardrailGate|metaApiClient)\.ts$/.test(path)) return [];
  const activates = /(status\s*:\s*["']ACTIVE["']|\?\s*["']ACTIVE["']|updateMetaObjectStatus\([^)]*["']ACTIVE["'])/;
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => activates.test(l));
  if (idx < 0 || /assertCanActivate\(/.test(content)) return [];
  return [{
    ruleId: "SPEC-1.4.4/activation-needs-guard",
    severity: "error",
    line: idx + 1,
    message: "ACTIVE にする前に utils/guardrailGate.ts の assertCanActivate()（dailySpendCap + LP死活）を通すこと",
    ref: "MASTER_SPEC 1.4-4",
  }];
}

/** 1.4-5: adcreatives を作るファイルは Advantage+ テキスト改変を OPT_OUT する */
function advantagePlusOptOut(path, content) {
  if (!isFunctionsCode(path) || !/adcreatives/.test(content)) return [];
  if (/degrees_of_freedom_spec/.test(content) && /enroll_status:\s*["']OPT_OUT["']/.test(content)) return [];
  const line = content.split("\n").findIndex((l) => /adcreatives/.test(l)) + 1;
  return [{
    ruleId: "SPEC-1.4.5/advantage-plus-opt-out",
    severity: "error",
    line,
    message: "adcreatives 入稿時は degrees_of_freedom_spec で enroll_status: \"OPT_OUT\" を必ず指定する",
    ref: "MASTER_SPEC 1.4-5",
  }];
}

// --- シークレット（GITHUB_RULES G5） --------------------------------------------

const SECRET_PATTERNS = [
  [/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/, "秘密鍵"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS アクセスキー"],
  [/\b(sk|rk)_(live|test)_[0-9A-Za-z]{16,}/, "Stripe シークレットキー"],
  [/\bwhsec_[0-9A-Za-z]{16,}/, "Stripe Webhook シークレット"],
  [/\bAIza[0-9A-Za-z_\-]{35}\b/, "Google API キー"],
  [/\bEAA[A-Za-z0-9]{60,}/, "Meta アクセストークン"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/, "GitHub トークン"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "Slack トークン"],
  [/"private_key"\s*:\s*"-----BEGIN/, "サービスアカウント鍵"],
];

function noSecrets(path, content) {
  if (/^scripts\/harness\/.*\.test\.mjs$/.test(path)) return [];
  const out = [];
  content.split("\n").forEach((text, i) => {
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(text)) {
        out.push({
          ruleId: "GH-G5/no-secrets",
          severity: "error",
          line: i + 1,
          message: `${label}らしき値。シークレットは Secret Manager / GitHub Secrets にのみ置く`,
          ref: "docs/GITHUB_RULES.md G5",
        });
      }
    }
  });
  return out;
}

/** コミットしてはいけないファイル名（安全ルール5「Secrets Awareness」の除外リストに準拠） */
export const FORBIDDEN_PATHS = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!local\.example$|example$)[^/]+$/,
  /serviceAccount[^/]*\.json$/i,
  /-firebase-adminsdk-[^/]*\.json$/,
  /\.(pem|p12|p8|pfx|key)$/,
  /(^|\/)AuthKey_[^/]*$/,
  /credentials[^/]*$/i,
  /(^|\/)\.(aws|ssh|gnupg|azure|gcloud|codeium|cursor)\//,
  /(^|\/)\.(bash|zsh|fish)_history$|\.history$/,
  /(^|\/)memo[^/]*\.txt$/,
  /(^|\/)\.claude\/settings\.local\.json$/,
];

/** 安全ルール4「公開バケット」: Storage / Firestore を無条件公開にしない */
function noPublicRules(path, content) {
  if (!/(^|\/)(storage|firestore)\.rules$/.test(path)) return [];
  const out = [];
  content.split("\n").forEach((text, i) => {
    if (/allow\s+[\w,\s]*(read|write|get|list|create|update|delete)[\w,\s]*:\s*if\s+true\b/.test(text)) {
      out.push({
        ruleId: "SAFETY-4/no-public-rules",
        severity: "error",
        line: i + 1,
        message: "Security Rules で `if true`（誰でも読み書き）にしない。認証・所有者条件を付ける",
        ref: "docs/GITHUB_RULES.md S4",
      });
    }
  });
  return out;
}

function forbiddenPath(path) {
  if (!FORBIDDEN_PATHS.some((re) => re.test(path))) return [];
  return [{
    ruleId: "GH-G5/forbidden-file",
    severity: "error",
    line: 0,
    message: "このファイルはコミット禁止（シークレット/ローカル設定/元メモ）",
    ref: "docs/GITHUB_RULES.md G5",
  }];
}

export const RULES = [
  forbiddenPath,
  noSecrets,
  noPublicRules,
  noHardcodedModelId,
  noTokenLog,
  noClientTokenAccess,
  noRawFetch,
  noAnyType,
  activationNeedsGuard,
  advantagePlusOptOut,
];

/**
 * 1ファイルに全ルールを適用する。
 * @param {string} path リポジトリルートからの相対パス（/ 区切り）
 * @param {string} content ファイル内容
 * @returns {Violation[]}
 */
export function checkFile(path, content) {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return RULES.flatMap((rule) => rule(normalized, content));
}

/** 違反を人間/AI が読める1行に整形する */
export function formatViolation(path, v) {
  const loc = v.line > 0 ? `${path}:${v.line}` : path;
  return `[${v.severity.toUpperCase()}] ${loc}  ${v.ruleId}  ${v.message}  (${v.ref})`;
}

/** 同じルール・同じ行内容の違反を「既存」とみなすためのキー（Edit フックで新規違反だけを止める用） */
export function violationKey(v, content) {
  const lineText = v.line > 0 ? (content.split("\n")[v.line - 1] || "").trim() : "";
  return `${v.ruleId}::${lineText}`;
}
