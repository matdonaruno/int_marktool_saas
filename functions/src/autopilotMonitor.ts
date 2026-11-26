import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { decryptToken } from "./utils/cryptoHelper";
import { META_BASE_URL, updateMetaObjectStatus } from "./utils/metaApiClient";
import { checkLandingPageHealth } from "./utils/healthCheck";
import { fetchWithTimeout } from "./utils/fetchWithTimeout";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const tokenEncryptionKey = defineSecret("TOKEN_ENCRYPTION_KEY");
const LEARNING_PHASE_MIN_IMPRESSIONS = 1000;

interface MetaActionMetric {
  action_type: string;
  value: string;
}

interface MetaAdInsight {
  ad_id: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: MetaActionMetric[];
  action_values?: MetaActionMetric[];
}

interface GuardrailSettings {
  dailySpendCap?: number;
  targetCpa?: number;
  minRoas?: number;
}

async function evaluateCampaignAds(
  userId: string,
  campDoc: FirebaseFirestore.QueryDocumentSnapshot,
  accessToken: string,
  guardrails: GuardrailSettings
): Promise<void> {
  const campaign = campDoc.data();
  if (campaign.productUrl) {
    const isLpHealthy = await checkLandingPageHealth(campaign.productUrl as string);
    if (!isLpHealthy) {
      await updateMetaObjectStatus(campaign.metaCampaignId as string, "PAUSED", accessToken);
      await campDoc.ref.update({
        status: "emergency_paused",
        pauseReason: "LP_HEALTH_CHECK_FAILED",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }
  }

  const insightsUrl = `${META_BASE_URL}/${campaign.metaCampaignId}/insights?fields=ad_id,spend,impressions,clicks,actions,action_values&level=ad&date_preset=last_3d&access_token=${accessToken}`;
  const insightsRes = await fetchWithTimeout(insightsUrl);
  if (!insightsRes.ok) return;

  const adInsightsList = ((await insightsRes.json()) as { data?: MetaAdInsight[] }).data || [];
  let totalCampaignSpend = 0;

  for (const insight of adInsightsList) {
    const spend = parseFloat(insight.spend || "0");
    const impressions = parseInt(insight.impressions || "0", 10);
    const clicks = parseInt(insight.clicks || "0", 10);
    totalCampaignSpend += spend;

    const purchaseAction = (insight.actions || []).find(
      (a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase"
    );
    const conversions = purchaseAction ? parseInt(purchaseAction.value, 10) : 0;

    const purchaseVal = (insight.action_values || []).find(
      (a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase"
    );
    const revenue = purchaseVal ? parseFloat(purchaseVal.value) : 0;

    const cpa = conversions > 0 ? spend / conversions : 0;
    const roas = spend > 0 ? revenue / spend : 0;

    const creativeQuery = await db
      .collection("users")
      .doc(userId)
      .collection("creatives")
      .where("metaAdId", "==", insight.ad_id)
      .limit(1)
      .get();

    if (creativeQuery.empty) continue;
    const creativeDoc = creativeQuery.docs[0];
    await creativeDoc.ref.update({
      metrics: { spend, impressions, clicks, conversions, cpa, roas },
      lastEvaluatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (impressions < LEARNING_PHASE_MIN_IMPRESSIONS) continue;

    const targetCpa = guardrails.targetCpa || 5000;
    const minRoas = guardrails.minRoas || 1.5;
    const isZeroConvBurn = conversions === 0 && spend >= targetCpa * 1.5;
    const isPoorPerf = conversions > 0 && cpa > targetCpa * 1.3 && roas < minRoas;

    if (isZeroConvBurn || isPoorPerf) {
      const paused = await updateMetaObjectStatus(insight.ad_id, "PAUSED", accessToken);
      if (paused) {
        await creativeDoc.ref.update({
          status: "killed",
          killReason: isZeroConvBurn ? "ZERO_CONVERSION_CAP" : "CPA_ROAS_THRESHOLD",
          killedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
  }

  if (guardrails.dailySpendCap && totalCampaignSpend > guardrails.dailySpendCap * 3) {
    await updateMetaObjectStatus(campaign.metaCampaignId as string, "PAUSED", accessToken);
    await campDoc.ref.update({
      status: "paused_by_cap",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

/**
 * Runs every 8 hours to enforce LP health checks (anti-burn), spend caps, and automated ad killing.
 */
export const runAutopilotMonitor = onSchedule(
  {
    schedule: "0 */8 * * *",
    timeZone: "Asia/Tokyo",
    secrets: [tokenEncryptionKey],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const usersSnap = await db.collection("users").where("guardrails.isAutopilotEnabled", "==", true).get();

    for (const userDoc of usersSnap.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data();
      const metaConn = userData.metaConnection;
      const guardrails = (userData.guardrails || {}) as GuardrailSettings;
      if (!metaConn?.encryptedAccessToken) continue;

      let accessToken = "";
      try {
        accessToken = decryptToken(metaConn.encryptedAccessToken as string, tokenEncryptionKey.value());
      } catch {
        continue;
      }

      const campaignsSnap = await db
        .collection("users")
        .doc(userId)
        .collection("campaigns")
        .where("status", "==", "active")
        .get();

      for (const campDoc of campaignsSnap.docs) {
        await evaluateCampaignAds(userId, campDoc, accessToken, guardrails);
      }
    }
  }
);
