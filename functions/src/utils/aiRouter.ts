import * as admin from "firebase-admin";
import { GoogleGenAI, Schema } from "@google/genai";

/** Firestore は使う時に初めて初期化する（ローカルモードでは触らない） */
function getDb(): admin.firestore.Firestore {
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}

export type AiTaskRole =
  | "copyGenerator"
  | "criticAgent"
  | "brandExtractor"
  | "imageGenerator"
  | "videoGenerator"
  | "decisionAgent";

export interface ModelRouteConfig {
  provider: "google" | "openai_compatible";
  modelId: string;
  temperature?: number;
  baseUrl?: string;
}

const DEFAULT_ROUTING: Record<AiTaskRole, ModelRouteConfig> = {
  copyGenerator: { provider: "google", modelId: "gemini-2.5-pro", temperature: 0.7 },
  criticAgent: { provider: "google", modelId: "gemini-2.5-flash", temperature: 0.2 },
  brandExtractor: { provider: "google", modelId: "gemini-2.5-pro", temperature: 0.3 },
  imageGenerator: { provider: "google", modelId: "imagen-3.0-generate-002" },
  videoGenerator: { provider: "google", modelId: "veo-2.0-generate-001" },
  decisionAgent: { provider: "google", modelId: "gemini-2.5-pro", temperature: 0.2 },
};

/** MASTER_SPEC 1.4-3: AI 呼び出しのタイムアウトとリトライ上限 */
export const AI_REQUEST_TIMEOUT_MS = 60000;
export const AI_MAX_ATTEMPTS = 3;

let cachedRouting: Record<AiTaskRole, ModelRouteConfig> | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;
let isStaticRouting = false;

/**
 * ローカルモード用: Firestore の systemConfig/aiModels を読まず、DEFAULT_ROUTING だけを使う。
 */
export function useStaticRouting(): void {
  isStaticRouting = true;
}

/**
 * Resolves the active AI model route for a given task role from Firestore (with 5-min cache).
 */
export async function getActiveModelRoute(role: AiTaskRole): Promise<ModelRouteConfig> {
  if (isStaticRouting) return DEFAULT_ROUTING[role];
  const now = Date.now();
  if (!cachedRouting || now - lastCacheTime > CACHE_TTL_MS) {
    const docSnap = await getDb().collection("systemConfig").doc("aiModels").get();
    const activeRouting = docSnap.exists ? docSnap.data()?.activeRouting : undefined;
    cachedRouting = activeRouting ? { ...DEFAULT_ROUTING, ...activeRouting } : DEFAULT_ROUTING;
    lastCacheTime = now;
  }
  return (cachedRouting ?? DEFAULT_ROUTING)[role];
}

/**
 * Executes a structured JSON generation task through the unified AI model router.
 */
export async function executeStructuredTextTask<T>(params: {
  role: AiTaskRole;
  prompt: string;
  responseSchema: Schema;
  apiKey: string;
  overrideModelId?: string;
  timeoutMs?: number;
}): Promise<{ data: T; usedModelId: string; latencyMs: number; estimatedTokens: number }> {
  const route = await getActiveModelRoute(params.role);
  const targetModelId = params.overrideModelId || route.modelId;
  const startTime = Date.now();

  const ai = new GoogleGenAI({ apiKey: params.apiKey });
  const response = await ai.models.generateContent({
    model: targetModelId,
    contents: params.prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: params.responseSchema,
      temperature: route.temperature ?? 0.5,
      httpOptions: {
        timeout: params.timeoutMs ?? AI_REQUEST_TIMEOUT_MS,
        retryOptions: { attempts: AI_MAX_ATTEMPTS },
      },
    },
  });

  const latencyMs = Date.now() - startTime;
  const rawText = response.text || "{}";
  const usage = response.usageMetadata;
  const estimatedTokens = (usage?.promptTokenCount || 0) + (usage?.candidatesTokenCount || 0);

  return {
    data: JSON.parse(rawText) as T,
    usedModelId: targetModelId,
    latencyMs,
    estimatedTokens,
  };
}
