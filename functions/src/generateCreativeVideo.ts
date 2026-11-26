import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { GoogleGenAI } from "@google/genai";
import { getActiveModelRoute } from "./utils/aiRouter";
import { fetchWithTimeout } from "./utils/fetchWithTimeout";

const VIDEO_DOWNLOAD_TIMEOUT_MS = 120000;

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const storage = admin.storage();
const geminiApiKey = defineSecret("GEMINI_API_KEY");

/**
 * Generates a 9:16 vertical short-form ad video via Veo 2 and stores it in Cloud Storage.
 */
export const generateCreativeVideo = onCall(
  { secrets: [geminiApiKey], timeoutSeconds: 540, memory: "2GiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const userId = request.auth.uid;
    const { creativeId } = request.data as { creativeId?: string };
    if (!creativeId) {
      throw new HttpsError("invalid-argument", "creativeId が必要です。");
    }

    const creativeRef = db.collection("users").doc(userId).collection("creatives").doc(creativeId);
    const creative = (await creativeRef.get()).data();
    if (!creative?.imagePrompt) {
      throw new HttpsError("failed-precondition", "プロンプトが存在しません。");
    }

    const route = await getActiveModelRoute("videoGenerator");
    const ai = new GoogleGenAI({ apiKey: geminiApiKey.value() });
    const videoPrompt = `${creative.imagePrompt}. Vertical 9:16 short-form social media ad video, smooth cinematic camera movement, natural authentic UGC lighting, no text overlay.`;

    let operation = await ai.models.generateVideos({
      model: route.modelId,
      prompt: videoPrompt,
      config: { aspectRatio: "9:16", personGeneration: "allow_adult" },
    });

    while (!operation.done) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      operation = await ai.operations.getVideosOperation({ operation });
    }

    const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
    if (!videoUri) {
      throw new HttpsError("internal", "動画生成に失敗しました。");
    }

    const videoResponse = await fetchWithTimeout(`${videoUri}&key=${geminiApiKey.value()}`, {}, VIDEO_DOWNLOAD_TIMEOUT_MS);
    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    const bucket = storage.bucket();
    const filePath = `users/${userId}/creatives/${creativeId}_${Date.now()}.mp4`;
    const file = bucket.file(filePath);

    await file.save(videoBuffer, {
      metadata: { contentType: "video/mp4", cacheControl: "public, max-age=31536000" },
    });

    const [signedUrl] = await file.getSignedUrl({ action: "read", expires: "03-01-2030" });
    await creativeRef.update({
      videoStoragePath: filePath,
      videoUrl: signedUrl,
      mediaType: "video",
      videoGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { creativeId, videoStoragePath: filePath, videoUrl: signedUrl };
  }
);
