import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { Type, Schema } from "@google/genai";
import { executeStructuredTextTask } from "./utils/aiRouter";
import { evaluateCreative, CriticOutput, PASSING_CRITIC_SCORE } from "./utils/criticAgent";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const geminiApiKey = defineSecret("GEMINI_API_KEY");
const MAX_ATTEMPTS = 3;

interface CreativeOutput {
  hook: string;
  primaryText: string;
  headline: string;
  imagePrompt: string;
  angle: string;
}

interface GenerateCreativeInput {
  campaignId?: string;
  productName?: string;
  productDescription?: string;
  targetAudience?: string;
  winningCompetitorAd?: string;
}

const creativeSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    hook: { type: Type.STRING, description: "最初の1秒で目を引くキャッチコピー（25文字以内）" },
    primaryText: { type: Type.STRING, description: "Meta広告のメインテキスト" },
    headline: { type: Type.STRING, description: "広告見出し（20文字以内）" },
    imagePrompt: { type: Type.STRING, description: "画像生成AIに渡す英語の詳細なプロンプト" },
    angle: { type: Type.STRING, description: "採用した訴求軸" },
  },
  required: ["hook", "primaryText", "headline", "imagePrompt", "angle"],
};

async function runGeneratorAndCriticLoop(
  input: Required<Pick<GenerateCreativeInput, "productName" | "productDescription">> & GenerateCreativeInput,
  apiKey: string
): Promise<{ creative: CreativeOutput; critic: CriticOutput }> {
  let currentCreative: CreativeOutput = { hook: "", primaryText: "", headline: "", imagePrompt: "", angle: "" };
  let criticResult: CriticOutput = { score: 0, isPassed: false, weaknesses: [], improvementInstruction: "" };
  let feedbackHistory = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const genPrompt = [
      "あなたはトップクラスのMeta広告メディアバイヤーです。高CVR広告クリエイティブ案を作成してください。",
      `商品名: ${input.productName}`,
      `詳細: ${input.productDescription}`,
      `ターゲット: ${input.targetAudience || "指定なし（商品から最適な層を推測）"}`,
      `競合勝ち広告: ${input.winningCompetitorAd || "一般的な高CVRパターン（悩み共感→新常識→限定CTA）"}`,
      feedbackHistory ? `前回批評エージェントからの修正指示:\n${feedbackHistory}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const genRes = await executeStructuredTextTask<CreativeOutput>({
      role: "copyGenerator",
      prompt: genPrompt,
      responseSchema: creativeSchema,
      apiKey,
    });
    currentCreative = genRes.data;

    criticResult = await evaluateCreative(currentCreative, apiKey);

    if (criticResult.isPassed && criticResult.score >= PASSING_CRITIC_SCORE) {
      break;
    }
    feedbackHistory = `スコア:${criticResult.score} 弱点:${criticResult.weaknesses.join(",")} 指示:${criticResult.improvementInstruction}`;
  }

  return { creative: currentCreative, critic: criticResult };
}

/**
 * Generates ad copy and evaluates it with the Critic agent up to MAX_ATTEMPTS times.
 */
export const generateVerifiedCreative = onCall(
  { secrets: [geminiApiKey], timeoutSeconds: 300, memory: "512MiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const userId = request.auth.uid;
    const data = request.data as GenerateCreativeInput;

    if (!data.campaignId || !data.productName || !data.productDescription) {
      throw new HttpsError("invalid-argument", "必須パラメータが不足しています。");
    }

    const { creative, critic } = await runGeneratorAndCriticLoop(
      { ...data, productName: data.productName, productDescription: data.productDescription },
      geminiApiKey.value()
    );

    const creativeRef = db.collection("users").doc(userId).collection("creatives").doc();
    const savedData = {
      campaignId: data.campaignId,
      metaAdId: null,
      ...creative,
      criticScore: critic.score,
      criticFeedback: critic.weaknesses,
      status: critic.isPassed && critic.score >= PASSING_CRITIC_SCORE ? "generated" : "needs_review",
      isOrganicPosted: false,
      metrics: { spend: 0, impressions: 0, clicks: 0, conversions: 0, cpa: 0, roas: 0 },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await creativeRef.set(savedData);
    return { creativeId: creativeRef.id, ...savedData };
  }
);
