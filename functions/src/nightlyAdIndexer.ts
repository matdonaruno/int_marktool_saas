import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { META_BASE_URL } from "./utils/metaApiClient";
import { fetchWithTimeout } from "./utils/fetchWithTimeout";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const metaLibraryAccessToken = defineSecret("META_LIBRARY_ACCESS_TOKEN");

const TARGET_KEYWORDS = ["スキンケア", "SaaS", "オンライン英会話", "ダイエット", "副業"];
const MIN_WINNING_ACTIVE_DAYS = 14;
const MS_PER_DAY = 86400000;

interface MetaArchiveAd {
  id: string;
  page_name?: string;
  ad_delivery_start_time?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_snapshot_url?: string;
}

async function fetchAdsForKeyword(keyword: string, token: string): Promise<MetaArchiveAd[]> {
  const searchUrl = new URL(`${META_BASE_URL}/ads_archive`);
  searchUrl.searchParams.append("search_terms", keyword);
  searchUrl.searchParams.append("ad_reached_countries", "['JP']");
  searchUrl.searchParams.append("ad_active_status", "ACTIVE");
  searchUrl.searchParams.append(
    "fields",
    "id,page_name,ad_delivery_start_time,ad_creative_bodies,ad_creative_link_titles,ad_snapshot_url"
  );
  searchUrl.searchParams.append("limit", "50");
  searchUrl.searchParams.append("access_token", token);

  const res = await fetchWithTimeout(searchUrl.toString());
  if (!res.ok) {
    console.error(`Ad Library API Error [${keyword}]:`, await res.text());
    return [];
  }
  const json = (await res.json()) as { data?: MetaArchiveAd[] };
  return json.data || [];
}

/**
 * Nightly batch job (3:00 AM JST) that indexes long-running (>=14 days) Meta ads as proven winners.
 */
export const indexWinningCompetitorAds = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "Asia/Tokyo",
    secrets: [metaLibraryAccessToken],
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const token = metaLibraryAccessToken.value();
    const now = Date.now();

    for (const keyword of TARGET_KEYWORDS) {
      const ads = await fetchAdsForKeyword(keyword, token);
      const batch = db.batch();
      let savedCount = 0;

      for (const ad of ads) {
        if (!ad.ad_delivery_start_time) continue;
        const activeDays = Math.floor((now - new Date(ad.ad_delivery_start_time).getTime()) / MS_PER_DAY);
        if (activeDays < MIN_WINNING_ACTIVE_DAYS) continue;

        batch.set(
          db.collection("competitorAds").doc(ad.id),
          {
            metaArchiveId: ad.id,
            keyword,
            pageName: ad.page_name || "Unknown",
            activeDays,
            primaryText: (ad.ad_creative_bodies || []).join("\n"),
            headline: (ad.ad_creative_link_titles || []).join(" / "),
            snapshotUrl: ad.ad_snapshot_url || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        savedCount++;
      }

      if (savedCount > 0) {
        await batch.commit();
        console.log(`[Nightly Indexer] キーワード「${keyword}」の勝ち広告を ${savedCount} 件保存しました。`);
      }
    }
  }
);
