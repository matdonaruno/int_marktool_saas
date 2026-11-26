import { HttpsError } from "firebase-functions/v2/https";

export const META_GRAPH_API_VERSION = "v21.0";
export const META_BASE_URL = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;

interface MetaApiErrorResponse {
  error?: {
    message?: string;
    type?: string;
    code?: number;
  };
}

/**
 * Sends a POST request to the Meta Graph API and throws HttpsError on failure.
 */
export async function postToMetaApi<T = Record<string, unknown>>(
  endpoint: string,
  payload: Record<string, unknown>,
  accessToken: string
): Promise<T> {
  const res = await fetch(`${META_BASE_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, access_token: accessToken }),
  });
  const data = (await res.json()) as T & MetaApiErrorResponse;
  if (!res.ok) {
    console.error(`Meta API Error [${endpoint}]:`, JSON.stringify(data));
    throw new HttpsError(
      "internal",
      `Meta APIエラー (${endpoint}): ${data.error?.message || "不明なエラー"}`
    );
  }
  return data;
}

/**
 * Updates the delivery status (PAUSED or ACTIVE) of a Meta ad object.
 */
export async function updateMetaObjectStatus(
  objectId: string,
  status: "PAUSED" | "ACTIVE",
  accessToken: string
): Promise<boolean> {
  try {
    await postToMetaApi(objectId, { status }, accessToken);
    return true;
  } catch {
    return false;
  }
}
