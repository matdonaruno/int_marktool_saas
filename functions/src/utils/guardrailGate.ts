import { HttpsError } from "firebase-functions/v2/https";
import { checkLandingPageHealth } from "./healthCheck";

export interface ActivationGuardInput {
  dailyBudget: number;
  dailySpendCap?: number;
  landingPageUrl: string;
}

/**
 * Throws unless the ad may be set to ACTIVE (MASTER_SPEC 1.4-4):
 *  - dailySpendCap is configured and the requested daily budget does not exceed it
 *  - the landing page answers HTTP 2xx within 10 seconds
 * Every code path that sets a Meta object to ACTIVE must call this first
 * (enforced by scripts/harness rule SPEC-1.4.4/activation-needs-guard).
 */
export async function assertCanActivate(input: ActivationGuardInput): Promise<void> {
  const { dailyBudget, dailySpendCap, landingPageUrl } = input;
  if (!dailySpendCap || dailySpendCap <= 0) {
    throw new HttpsError("failed-precondition", "dailySpendCap が未設定のため ACTIVE 入稿できません。");
  }
  if (dailyBudget > dailySpendCap) {
    throw new HttpsError(
      "failed-precondition",
      `日予算 (${dailyBudget}) が dailySpendCap (${dailySpendCap}) を超えています。`
    );
  }
  const isLpHealthy = await checkLandingPageHealth(landingPageUrl);
  if (!isLpHealthy) {
    throw new HttpsError("failed-precondition", "LPが応答しないため ACTIVE 入稿を中止しました。");
  }
}
