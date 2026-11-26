import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import sharp from "sharp";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const storage = admin.storage();

function escapeXml(unsafeText: string): string {
  return unsafeText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildOverlaySvg(width: number, height: number, hookText: string, accentColor: string): Buffer {
  const safeText = escapeXml(hookText);
  const bannerHeight = Math.round(height * 0.18);
  const bannerY = height - bannerHeight;
  const fontSize = Math.max(28, Math.round(width * 0.042));

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${accentColor}" stop-opacity="0.88"/>
          <stop offset="100%" stop-color="#111111" stop-opacity="0.95"/>
        </linearGradient>
      </defs>
      <rect x="0" y="${bannerY}" width="${width}" height="${bannerHeight}" fill="url(#bgGrad)" />
      <rect x="0" y="${bannerY}" width="${width}" height="6" fill="#FFFFFF" fill-opacity="0.6" />
      <text
        x="50%"
        y="${bannerY + bannerHeight / 2 + fontSize * 0.35}"
        font-family="Noto Sans CJK JP, Hiragino Sans, sans-serif"
        font-size="${fontSize}"
        font-weight="bold"
        fill="#FFFFFF"
        text-anchor="middle"
      >${safeText}</text>
    </svg>
  `;
  return Buffer.from(svg);
}

/**
 * Composites the Critic-approved hook text and brand color banner onto the base creative image.
 */
export const compositeAdOverlay = onCall(
  { timeoutSeconds: 120, memory: "1GiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const userId = request.auth.uid;
    const { creativeId, brandColor = "#1E3A8A" } = request.data as {
      creativeId?: string;
      brandColor?: string;
    };
    if (!creativeId) {
      throw new HttpsError("invalid-argument", "creativeId が必要です。");
    }

    const creativeRef = db.collection("users").doc(userId).collection("creatives").doc(creativeId);
    const creative = (await creativeRef.get()).data();
    if (!creative?.mediaStoragePath || !creative?.hook) {
      throw new HttpsError("failed-precondition", "元画像またはコピーが存在しません。");
    }

    const bucket = storage.bucket();
    const [imageBuffer] = await bucket.file(creative.mediaStoragePath as string).download();
    const metadata = await sharp(imageBuffer).metadata();
    const overlaySvgBuffer = buildOverlaySvg(
      metadata.width || 1080,
      metadata.height || 1080,
      creative.hook as string,
      brandColor
    );

    const compositedBuffer = await sharp(imageBuffer)
      .composite([{ input: overlaySvgBuffer, top: 0, left: 0 }])
      .jpeg({ quality: 92 })
      .toBuffer();

    const compositedPath = `users/${userId}/creatives/${creativeId}_composited_${Date.now()}.jpg`;
    const destFile = bucket.file(compositedPath);
    await destFile.save(compositedBuffer, {
      metadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000" },
    });

    const [signedUrl] = await destFile.getSignedUrl({ action: "read", expires: "03-01-2030" });
    await creativeRef.update({
      compositedStoragePath: compositedPath,
      mediaUrl: signedUrl,
      isComposited: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { creativeId, compositedStoragePath: compositedPath, mediaUrl: signedUrl };
  }
);
