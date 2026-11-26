import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { Type, Schema } from "@google/genai";
import { executeStructuredTextTask } from "./utils/aiRouter";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const geminiApiKey = defineSecret("GEMINI_API_KEY");
const FETCH_TIMEOUT_MS = 15000;

interface BrandDnaResult {
  brandName: string;
  brandColors: string[];
  corePainPoints: string[];
  uniqueSellingPoints: string[];
  extractedReviews: string;
  recommendedTargetAudience: string;
}

const brandDnaSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    brandName: { type: Type.STRING, description: "ブランド名または商品名" },
    brandColors: { type: Type.ARRAY, items: { type: Type.STRING }, description: "主要HEXカラーコード（2〜3色）" },
    corePainPoints: { type: Type.ARRAY, items: { type: Type.STRING }, description: "ターゲットの深い悩み（3〜5個）" },
    uniqueSellingPoints: { type: Type.ARRAY, items: { type: Type.STRING }, description: "独自性・強み（3〜5個）" },
    extractedReviews: { type: Type.STRING, description: "顧客レビューや導入実績の要約" },
    recommendedTargetAudience: { type: Type.STRING, description: "最適なターゲット層" },
  },
  required: [
    "brandName",
    "brandColors",
    "corePainPoints",
    "uniqueSellingPoints",
    "extractedReviews",
    "recommendedTargetAudience",
  ],
};

function sanitizeHtmlToText(rawHtml: string): string {
  return rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 15000);
}

async function fetchProductPageText(productUrl: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(productUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BrandDnaExtractor/1.0)" },
    });
    if (!res.ok) {
      throw new HttpsError("internal", `URL取得失敗: ${res.status}`);
    }
    return sanitizeHtmlToText(await res.text());
  } catch (err: unknown) {
    if (err instanceof HttpsError) throw err;
    const message = err instanceof Error ? err.message : "不明なエラー";
    throw new HttpsError("internal", `URLの取得に失敗しました: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Scrapes a product landing page and extracts structured Brand DNA using the AI router.
 */
export const extractBrandDna = onCall(
  { secrets: [geminiApiKey], timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const userId = request.auth.uid;
    const { productUrl } = request.data as { productUrl?: string };
    if (!productUrl || typeof productUrl !== "string") {
      throw new HttpsError("invalid-argument", "有効な商品URLが必要です。");
    }

    const cleanedText = await fetchProductPageText(productUrl);
    const result = await executeStructuredTextTask<BrandDnaResult>({
      role: "brandExtractor",
      prompt: `以下の販売ページテキストからMeta広告制作に必要なブランドDNAを抽出してください。\nURL: ${productUrl}\nテキスト: ${cleanedText}`,
      responseSchema: brandDnaSchema,
      apiKey: geminiApiKey.value(),
    });

    const brandRef = db.collection("users").doc(userId).collection("brands").doc();
    const savedRecord = {
      productUrl,
      ...result.data,
      usedModelId: result.usedModelId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await brandRef.set(savedRecord);
    return { brandId: brandRef.id, ...savedRecord };
  }
);
