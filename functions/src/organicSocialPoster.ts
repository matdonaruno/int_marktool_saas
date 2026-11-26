import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { decryptToken } from "./utils/cryptoHelper";
import { META_BASE_URL, postToMetaApi } from "./utils/metaApiClient";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const tokenEncryptionKey = defineSecret("TOKEN_ENCRYPTION_KEY");

interface PageInfoResponse {
  access_token?: string;
  instagram_business_account?: { id?: string };
}

/**
 * Daily scheduler (19:00 JST) that posts one unposted approved creative to Facebook & Instagram.
 */
export const runDailyOrganicSocialPost = onSchedule(
  {
    schedule: "0 19 * * *",
    timeZone: "Asia/Tokyo",
    secrets: [tokenEncryptionKey],
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const usersSnap = await db
      .collection("users")
      .where("guardrails.isOrganicAutoPostEnabled", "==", true)
      .get();

    for (const userDoc of usersSnap.docs) {
      const userId = userDoc.id;
      const metaConn = userDoc.data().metaConnection;
      if (!metaConn?.encryptedAccessToken || !metaConn?.selectedFacebookPageId) continue;

      let userToken = "";
      try {
        userToken = decryptToken(metaConn.encryptedAccessToken as string, tokenEncryptionKey.value());
      } catch {
        continue;
      }

      const creativeSnap = await db
        .collection("users")
        .doc(userId)
        .collection("creatives")
        .where("status", "in", ["generated", "live"])
        .where("isOrganicPosted", "==", false)
        .limit(1)
        .get();

      if (creativeSnap.empty) continue;
      const creativeDoc = creativeSnap.docs[0];
      const creative = creativeDoc.data();
      if (!creative.mediaUrl) continue;

      const caption = `${creative.hook}\n\n${creative.primaryText}`;
      const pageId = metaConn.selectedFacebookPageId as string;

      try {
        const pageRes = await fetch(
          `${META_BASE_URL}/${pageId}?fields=access_token,instagram_business_account&access_token=${userToken}`
        );
        const pageData = (await pageRes.json()) as PageInfoResponse;

        if (pageData.access_token) {
          await postToMetaApi(
            `${pageId}/photos`,
            { url: creative.mediaUrl, message: caption },
            pageData.access_token
          );
        }

        const igId = pageData.instagram_business_account?.id;
        if (igId) {
          const container = await postToMetaApi<{ id: string }>(
            `${igId}/media`,
            { image_url: creative.mediaUrl, caption },
            userToken
          );
          if (container.id) {
            await postToMetaApi(`${igId}/media_publish`, { creation_id: container.id }, userToken);
          }
        }

        await creativeDoc.ref.update({
          isOrganicPosted: true,
          organicPostedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (err) {
        console.error(`[Organic Post Error] User: ${userId}, Creative: ${creativeDoc.id}`, err);
      }
    }
  }
);
