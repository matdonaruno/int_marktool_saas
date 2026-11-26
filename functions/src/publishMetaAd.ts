import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { decryptToken } from "./utils/cryptoHelper";
import { postToMetaApi } from "./utils/metaApiClient";
import { assertCanActivate } from "./utils/guardrailGate";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const tokenEncryptionKey = defineSecret("TOKEN_ENCRYPTION_KEY");

interface PublishMetaAdInput {
  creativeId?: string;
  campaignName?: string;
  dailyBudget?: number;
  targetCountry?: string;
  landingPageUrl?: string;
  facebookPageId?: string;
  pixelId?: string;
}

interface MetaAdImageResponse {
  images?: Record<string, { hash?: string }>;
}

interface MetaIdResponse {
  id: string;
}

/**
 * Publishes a creative to Meta Marketing API (Image -> Campaign -> AdSet -> AdCreative -> Ad).
 * Explicitly opts out of Advantage+ creative text enhancements.
 */
export const publishCreativeToMeta = onCall(
  { secrets: [tokenEncryptionKey], timeoutSeconds: 180, memory: "512MiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const userId = request.auth.uid;
    const {
      creativeId,
      campaignName,
      dailyBudget,
      targetCountry = "JP",
      landingPageUrl,
      facebookPageId,
      pixelId,
    } = request.data as PublishMetaAdInput;

    if (!creativeId || !landingPageUrl || !facebookPageId || !dailyBudget) {
      throw new HttpsError("invalid-argument", "入稿パラメータが不足しています。");
    }

    const userSnap = await db.collection("users").doc(userId).get();
    const userData = userSnap.data();
    const metaConn = userData?.metaConnection;
    const guardrails = userData?.guardrails || {};

    if (!metaConn?.encryptedAccessToken || !metaConn?.selectedAdAccountId) {
      throw new HttpsError("failed-precondition", "Meta広告アカウントが連携されていません。");
    }

    const adAccountId = metaConn.selectedAdAccountId as string;
    const accessToken = decryptToken(metaConn.encryptedAccessToken as string, tokenEncryptionKey.value());

    const creativeRef = db.collection("users").doc(userId).collection("creatives").doc(creativeId);
    const creative = (await creativeRef.get()).data();
    if (!creative?.mediaUrl) {
      throw new HttpsError("failed-precondition", "画像が未生成です。");
    }

    const shouldActivate = guardrails.isAutopilotEnabled === true;
    if (shouldActivate) {
      await assertCanActivate({
        dailyBudget,
        dailySpendCap: guardrails.dailySpendCap,
        landingPageUrl,
      });
    }
    const initialStatus: "ACTIVE" | "PAUSED" = shouldActivate ? "ACTIVE" : "PAUSED";

    const imageRes = await postToMetaApi<MetaAdImageResponse>(
      `${adAccountId}/adimages`,
      { url: creative.mediaUrl },
      accessToken
    );
    const imagesObj = imageRes.images || {};
    const firstKey = Object.keys(imagesObj)[0];
    const imageHash = firstKey ? imagesObj[firstKey]?.hash : undefined;
    if (!imageHash) {
      throw new HttpsError("internal", "Metaへの画像アップロードに失敗しました。");
    }

    const campRes = await postToMetaApi<MetaIdResponse>(
      `${adAccountId}/campaigns`,
      {
        name: campaignName || `AI_Auto_${creative.angle}_${new Date().toISOString().slice(0, 10)}`,
        objective: "OUTCOME_SALES",
        status: initialStatus,
        special_ad_categories: [],
      },
      accessToken
    );

    const adSetPayload: Record<string, unknown> = {
      name: `AdSet_Broad_${targetCountry}_${Date.now()}`,
      campaign_id: campRes.id,
      daily_budget: dailyBudget,
      billing_event: "IMPRESSIONS",
      optimization_goal: pixelId ? "OFFSITE_CONVERSIONS" : "LINK_CLICKS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: { geo_locations: { countries: [targetCountry] }, age_min: 20, age_max: 65 },
      status: initialStatus,
    };
    if (pixelId) {
      adSetPayload.promoted_object = { pixel_id: pixelId, custom_event_type: "PURCHASE" };
    }
    const adSetRes = await postToMetaApi<MetaIdResponse>(`${adAccountId}/adsets`, adSetPayload, accessToken);

    const adCreativeRes = await postToMetaApi<MetaIdResponse>(
      `${adAccountId}/adcreatives`,
      {
        name: `Creative_${creativeId}`,
        object_story_spec: {
          page_id: facebookPageId,
          link_data: {
            image_hash: imageHash,
            link: landingPageUrl,
            message: creative.primaryText,
            name: creative.headline,
            call_to_action: { type: "LEARN_MORE", value: { link: landingPageUrl } },
          },
        },
        degrees_of_freedom_spec: {
          creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } },
        },
      },
      accessToken
    );

    const adRes = await postToMetaApi<MetaIdResponse>(
      `${adAccountId}/ads`,
      {
        name: `Ad_${creative.angle}_${creativeId.slice(0, 6)}`,
        adset_id: adSetRes.id,
        creative: { creative_id: adCreativeRes.id },
        status: initialStatus,
      },
      accessToken
    );

    const campaignDocRef = db.collection("users").doc(userId).collection("campaigns").doc();
    await campaignDocRef.set({
      metaCampaignId: campRes.id,
      metaAdSetId: adSetRes.id,
      productUrl: landingPageUrl,
      status: initialStatus === "ACTIVE" ? "active" : "paused",
      budget: dailyBudget,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await creativeRef.update({
      campaignId: campaignDocRef.id,
      metaAdId: adRes.id,
      metaCreativeId: adCreativeRes.id,
      status: initialStatus === "ACTIVE" ? "live" : "pending_approval",
      publishedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      metaCampaignId: campRes.id,
      metaAdSetId: adSetRes.id,
      metaAdId: adRes.id,
      status: initialStatus,
    };
  }
);
