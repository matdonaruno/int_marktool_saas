import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { executeStructuredTextTask, getActiveModelRoute } from "./utils/aiRouter";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const geminiApiKey = defineSecret("GEMINI_API_KEY");

interface CandidateModelInfo {
  modelId: string;
  recommendedRole: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  apiUsageNotes: string;
}

interface BenchmarkCopyOutput {
  hook: string;
  primaryText: string;
}

const modelResearchSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    candidateModels: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          modelId: { type: Type.STRING },
          recommendedRole: { type: Type.STRING },
          inputCostPer1M: { type: Type.NUMBER },
          outputCostPer1M: { type: Type.NUMBER },
          apiUsageNotes: { type: Type.STRING },
        },
        required: ["modelId", "recommendedRole", "inputCostPer1M", "outputCostPer1M", "apiUsageNotes"],
      },
    },
  },
  required: ["candidateModels"],
};

const BENCHMARK_PROMPT =
  "商品名: スマート姿勢矯正デバイス PostureSync\n詳細: 猫背を振動検知し姿勢スコアを可視化するウェアラブル端末。\n高CVRなMeta広告コピーを作成してください。";

async function executeModelOptimization(apiKey: string) {
  const ai = new GoogleGenAI({ apiKey });
  const currentRoute = await getActiveModelRoute("copyGenerator");

  const researchRes = await ai.models.generateContent({
    model: currentRoute.modelId,
    contents:
      "最新のGoogle Gemini APIで利用可能な安定版モデルID・100万トークン単価(USD)・呼び出し仕様変更を調査し、copyGeneratorとcriticAgentに最適な候補を挙げてください。",
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
      responseSchema: modelResearchSchema,
      temperature: 0.1,
    },
  });

  const parsedResearch = JSON.parse(researchRes.text || "{}") as {
    candidateModels?: CandidateModelInfo[];
  };
  const candidates = parsedResearch.candidateModels || [];

  const testSchema: Schema = {
    type: Type.OBJECT,
    properties: { hook: { type: Type.STRING }, primaryText: { type: Type.STRING } },
    required: ["hook", "primaryText"],
  };

  const baseline = await executeStructuredTextTask<BenchmarkCopyOutput>({
    role: "copyGenerator",
    prompt: BENCHMARK_PROMPT,
    responseSchema: testSchema,
    apiKey,
    overrideModelId: currentRoute.modelId,
  });

  const logs: Array<CandidateModelInfo & { latencyMs?: number; passed: boolean; error?: string }> = [];

  for (const candidate of candidates) {
    if (candidate.recommendedRole !== "copyGenerator" || candidate.modelId === currentRoute.modelId) {
      continue;
    }
    try {
      const testRes = await executeStructuredTextTask<BenchmarkCopyOutput>({
        role: "copyGenerator",
        prompt: BENCHMARK_PROMPT,
        responseSchema: testSchema,
        apiKey,
        overrideModelId: candidate.modelId,
      });
      const isOk =
        Boolean(testRes.data.hook && testRes.data.primaryText) &&
        testRes.latencyMs <= baseline.latencyMs * 1.2;
      logs.push({ ...candidate, latencyMs: testRes.latencyMs, passed: isOk });

      if (isOk) {
        await db.collection("systemConfig").doc("aiModels").set(
          {
            activeRouting: {
              copyGenerator: { provider: "google", modelId: candidate.modelId, temperature: 0.7 },
            },
            lastAutoPromotedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logs.push({ ...candidate, passed: false, error: message });
    }
  }

  await db.collection("systemConfig").doc("aiModels").set(
    { latestEvaluationLogs: logs, lastCheckedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );

  return { currentModel: currentRoute.modelId, evaluatedCandidates: logs };
}

/**
 * Weekly scheduler (Mondays 4:00 AM JST) to benchmark and promote optimal AI models.
 */
export const runModelAutoOptimizer = onSchedule(
  { schedule: "0 4 * * 1", timeZone: "Asia/Tokyo", secrets: [geminiApiKey], timeoutSeconds: 300 },
  async () => {
    await executeModelOptimization(geminiApiKey.value());
  }
);

/**
 * Manual trigger for administrators to run model discovery and benchmarking immediately.
 */
export const triggerModelOptimizationNow = onCall(
  { secrets: [geminiApiKey], timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "認証が必要です。");
    }
    return await executeModelOptimization(geminiApiKey.value());
  }
);
