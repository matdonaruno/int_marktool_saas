import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { encryptToken } from "./utils/cryptoHelper";
import { META_BASE_URL } from "./utils/metaApiClient";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

const metaAppId = defineSecret("META_APP_ID");
const metaAppSecret = defineSecret("META_APP_SECRET");
const tokenEncryptionKey = defineSecret("TOKEN_ENCRYPTION_KEY");

interface MetaTokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface MetaListResponse<T> {
  data?: T[];
}

interface MetaAdAccountItem {
  id: string;
  name: string;
  currency?: string;
  account_status?: number;
}

interface MetaPageItem {
  id: string;
  name: string;
}

/**
 * Exchanges a short-lived Meta OAuth token for a 60-day long-lived token,
 * encrypts it, stores it in Firestore, and returns ad accounts and pages.
 */
export const connectMetaAccount = onCall(
  { secrets: [metaAppId, metaAppSecret, tokenEncryptionKey], timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const userId = request.auth.uid;
    const { shortLivedToken } = request.data as { shortLivedToken?: string };
    if (!shortLivedToken) {
      throw new HttpsError("invalid-argument", "Metaアクセストークンが必要です。");
    }

    const exchangeUrl = new URL(`${META_BASE_URL}/oauth/access_token`);
    exchangeUrl.searchParams.append("grant_type", "fb_exchange_token");
    exchangeUrl.searchParams.append("client_id", metaAppId.value());
    exchangeUrl.searchParams.append("client_secret", metaAppSecret.value());
    exchangeUrl.searchParams.append("fb_exchange_token", shortLivedToken);

    const tokenRes = await fetch(exchangeUrl.toString());
    const tokenData = (await tokenRes.json()) as MetaTokenResponse;
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new HttpsError("internal", "Meta長期トークンの取得に失敗しました。");
    }

    const longLivedToken = tokenData.access_token;
    const expiresInSeconds = tokenData.expires_in || 5184000;
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + expiresInSeconds * 1000);

    const [adAccountsRes, pagesRes] = await Promise.all([
      fetch(`${META_BASE_URL}/me/adaccounts?fields=id,name,currency,account_status&access_token=${longLivedToken}`),
      fetch(`${META_BASE_URL}/me/accounts?fields=id,name&access_token=${longLivedToken}`),
    ]);
    const adAccountsData = (await adAccountsRes.json()) as MetaListResponse<MetaAdAccountItem>;
    const pagesData = (await pagesRes.json()) as MetaListResponse<MetaPageItem>;

    const encryptedToken = encryptToken(longLivedToken, tokenEncryptionKey.value());
    await db.collection("users").doc(userId).set(
      {
        metaConnection: {
          encryptedAccessToken: encryptedToken,
          tokenExpiresAt: expiresAt,
          connectedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );

    return {
      success: true,
      adAccounts: adAccountsData.data || [],
      pages: pagesData.data || [],
    };
  }
);
