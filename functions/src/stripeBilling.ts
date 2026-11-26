import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import Stripe from "stripe";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

interface CheckoutInput {
  priceId?: string;
  meteredPriceId?: string;
  successUrl?: string;
  cancelUrl?: string;
}

function createStripeClient(): Stripe {
  return new Stripe(stripeSecretKey.value(), {
    apiVersion: "2025-02-24.acacia" as Stripe.LatestApiVersion,
  });
}

/**
 * Creates a Stripe Checkout Session for base subscription + optional 5% metered ad spend billing.
 */
export const createStripeCheckoutSession = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const { priceId, meteredPriceId, successUrl, cancelUrl } = request.data as CheckoutInput;
    if (!priceId || !successUrl || !cancelUrl) {
      throw new HttpsError("invalid-argument", "Stripe決済パラメータが不足しています。");
    }

    const stripe = createStripeClient();
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: priceId, quantity: 1 }];
    if (meteredPriceId) {
      lineItems.push({ price: meteredPriceId });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: lineItems,
      client_reference_id: request.auth.uid,
      customer_email: request.auth.token.email,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return { url: session.url };
  }
);

/**
 * Handles Stripe subscription lifecycle webhooks to keep Firestore user plans in sync.
 */
export const stripeWebhook = onRequest(
  { secrets: [stripeSecretKey, stripeWebhookSecret] },
  async (req, res) => {
    const stripe = createStripeClient();
    const sig = req.headers["stripe-signature"] as string;
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, stripeWebhookSecret.value());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Invalid signature";
      res.status(400).send(`Webhook Error: ${message}`);
      return;
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.client_reference_id) {
        await db.collection("users").doc(session.client_reference_id).set(
          {
            plan: "pro",
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    } else if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const snap = await db.collection("users").where("stripeSubscriptionId", "==", sub.id).limit(1).get();
      if (!snap.empty) {
        await snap.docs[0].ref.update({
          plan: "free",
          "guardrails.isAutopilotEnabled": false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    res.json({ received: true });
  }
);

/**
 * Daily scheduler (2:00 AM JST) that reports 5% Autopilot ad spend fee to Stripe Billing Meter.
 */
export const reportAutopilotUsageToStripe = onSchedule(
  { schedule: "0 2 * * *", timeZone: "Asia/Tokyo", secrets: [stripeSecretKey] },
  async () => {
    const stripe = createStripeClient();
    const usersSnap = await db
      .collection("users")
      .where("plan", "==", "pro")
      .where("guardrails.isAutopilotEnabled", "==", true)
      .get();

    for (const docSnap of usersSnap.docs) {
      const data = docSnap.data();
      const spend = (data.billing?.pendingBillableSpend as number) || 0;
      const feeAmount = Math.round(spend * 0.05);

      if (data.stripeCustomerId && feeAmount > 0) {
        await stripe.billing.meterEvents.create({
          event_name: "autopilot_ad_spend_fee",
          payload: {
            value: String(feeAmount),
            stripe_customer_id: data.stripeCustomerId as string,
          },
        });
        await docSnap.ref.update({
          "billing.pendingBillableSpend": 0,
          "billing.lastReportedAt": admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
  }
);
