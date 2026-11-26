import * as crypto from "crypto";

/**
 * Encrypts a plain text token using AES-256-GCM.
 */
export function encryptToken(plainText: string, keyHex: string): string {
  const iv = crypto.randomBytes(12);
  const key = Buffer.from(keyHex, "hex");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plainText, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted token string.
 */
export function decryptToken(encryptedText: string, keyHex: string): string {
  const [ivHex, authTagHex, cipherTextHex] = encryptedText.split(":");
  if (!ivHex || !authTagHex || !cipherTextHex) {
    throw new Error("不正な暗号化トークンフォーマットです。");
  }
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const key = Buffer.from(keyHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(cipherTextHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
