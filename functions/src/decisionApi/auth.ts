import { createHash, randomBytes } from "node:crypto";

/** API キーの接頭辞（漏えい時に GitHub secret scanning 等で見つけやすくする） */
export const API_KEY_PREFIX = "dak_";

/** 新しい API キーを生成する（256bit）。平文は発行時に1回だけ表示し、保存はハッシュのみ */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString("base64url");
}

/** API キーは高エントロピーなので、ソルトなし SHA-256 で照合用ハッシュにする */
export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

/** `Authorization: Bearer <key>` または `X-Api-Key: <key>` から取り出す */
export function extractApiKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers["authorization"];
  const authValue = Array.isArray(auth) ? auth[0] : auth;
  if (authValue?.startsWith("Bearer ")) return authValue.slice(7).trim() || null;
  const x = headers["x-api-key"];
  const xValue = Array.isArray(x) ? x[0] : x;
  return xValue?.trim() || null;
}
