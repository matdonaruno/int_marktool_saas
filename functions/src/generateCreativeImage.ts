import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { GoogleGenAI } from "@google/genai";
import { getActiveModelRoute } from "./utils/aiRouter";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const storage = admin.storage();
const geminiApiKey = defineSecret("GEMINI_API_KEY");

/**
 * Generates an ad creative image using Imagen via the AI router and saves it to Cloud Storage.
 */
export const generateCreativeImage = onCall(
  { secrets: [geminiApiKey], timeoutSeconds: 180, memory: "1GiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const userId = request.auth.uid;
    const { creativeId, aspectRatio = "1:1" } = request.data as {
      creativeId?: string;
      aspectRatio?: "1:1" | "9:16" | "16:9";
    };
    if (!creativeId) {
      throw new HttpsError("invalid-argument", "creativeId が必要です。");
    }

    const creativeRef = db.collection("users").doc(userId).collection("creatives").doc(creativeId);
    const creativeSnap = await creativeRef.get();
    const basePrompt = creativeSnap.data()?.imagePrompt as string | undefined;
    if (!basePrompt) {
      throw new HttpsError("failed-precondition", "imagePrompt が存在しません。");
    }

    const route = await getActiveModelRoute("imageGenerator");
    const ai = new GoogleGenAI({ apiKey: geminiApiKey.value() });
    const enhancedPrompt = `${basePrompt}. High-converting Meta ad creative style, clean composition, natural lighting, photorealistic, high resolution, NO embedded text or watermarks.`;

    const response = await ai.models.generateImages({
      model: route.modelId,
      prompt: enhancedPrompt,
      config: { numberOfImages: 1, outputMimeType: "image/jpeg", aspectRatio },
    });

    const imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
    if (!imageBytes) {
      throw new HttpsError("internal", "画像生成に失敗しました。");
    }

    const bucket = storage.bucket();
    const filePath = `users/${userId}/creatives/${creativeId}_${Date.now()}.jpg`;
    const file = bucket.file(filePath);
    await file.save(Buffer.from(imageBytes, "base64"), {
      metadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000" },
    });

    const [signedUrl] = await file.getSignedUrl({ action: "read", expires: "03-01-2030" });
    await creativeRef.update({
      mediaStoragePath: filePath,
      mediaUrl: signedUrl,
      aspectRatio,
      imageGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { creativeId, mediaStoragePath: filePath, mediaUrl: signedUrl };
  }
);
