import { Router } from "express";
import express from "express";
import { getStripe, planFromPriceId, PLAN_LIMITS } from "../lib/stripe.js";
import { getQstashReceiver } from "../lib/qstash.js";
import { Subscription, Team } from "../models/index.js";

const router = Router();

// ── Stripe webhook ────────────────────────────────────────────────────────
// Needs the RAW body for signature verification, so we mount express.raw()
// only on this route.
router.post(
  "/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const stripe = getStripe();
    const sig    = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Stripe signature verify failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const teamId  = session.metadata?.teamId;
          if (teamId && session.subscription) {
            const stripeSub = await stripe.subscriptions.retrieve(session.subscription);
            const priceId   = stripeSub.items.data[0]?.price?.id;
            const plan      = planFromPriceId(priceId);
            const limits    = PLAN_LIMITS[plan];
            await Subscription.findOneAndUpdate(
              { teamId },
              {
                stripeCustomerId:  session.customer,
                stripeSubId:       stripeSub.id,
                plan,
                status:            stripeSub.status,
                currentPeriodEnd:  new Date(stripeSub.current_period_end * 1000),
                cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
                ...limits,
              },
              { upsert: true }
            );
            await Team.findByIdAndUpdate(teamId, { plan });
          }
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const priceId = sub.items.data[0]?.price?.id;
          const plan    = event.type === "customer.subscription.deleted"
            ? "free"
            : planFromPriceId(priceId);
          const limits  = PLAN_LIMITS[plan];
          const dbSub = await Subscription.findOneAndUpdate(
            { stripeSubId: sub.id },
            {
              plan,
              status:            event.type === "customer.subscription.deleted" ? "canceled" : sub.status,
              currentPeriodEnd:  new Date(sub.current_period_end * 1000),
              cancelAtPeriodEnd: sub.cancel_at_period_end,
              ...limits,
            },
            { new: true }
          );
          if (dbSub?.teamId) await Team.findByIdAndUpdate(dbSub.teamId, { plan });
          break;
        }
        case "invoice.payment_failed": {
          const subId = typeof event.data.object.subscription === "string"
            ? event.data.object.subscription
            : event.data.object.subscription?.id;
          if (subId) await Subscription.findOneAndUpdate({ stripeSubId: subId }, { status: "past_due" });
          break;
        }
        case "invoice.payment_succeeded": {
          const subId = typeof event.data.object.subscription === "string"
            ? event.data.object.subscription
            : event.data.object.subscription?.id;
          if (subId) {
            const stripeSub = await stripe.subscriptions.retrieve(subId);
            await Subscription.findOneAndUpdate(
              { stripeSubId: subId },
              { status: stripeSub.status, currentPeriodEnd: new Date(stripeSub.current_period_end * 1000) }
            );
          }
          break;
        }
        default:
          // no-op for unhandled events
          break;
      }
      res.json({ received: true });
    } catch (err) {
      console.error("Stripe handler error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ── QStash job receivers ──────────────────────────────────────────────────
// QStash signs requests with Upstash-Signature; verify before running.

async function verifyQstash(req) {
  if (process.env.RUN_LOCAL === "1") return true;
  const signature = req.headers["upstash-signature"];
  const body = JSON.stringify(req.body);
  const receiver = getQstashReceiver();
  try {
    await receiver.verify({ signature, body });
    return true;
  } catch {
    return false;
  }
}

// POST /api/webhooks/run-campaign
router.post("/run-campaign", express.json(), async (req, res) => {
  if (!(await verifyQstash(req))) return res.status(401).json({ error: "Invalid signature" });
  try {
    const { campaignId } = req.body;
    const { runCampaign } = await import("../workers/campaignRunner.js");
    await runCampaign(campaignId);
    res.json({ success: true });
  } catch (err) {
    console.error("[run-campaign]", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webhooks/calculate-score
router.post("/calculate-score", express.json(), async (req, res) => {
  if (!(await verifyQstash(req))) return res.status(401).json({ error: "Invalid signature" });
  try {
    const { projectId } = req.body;
    const { calculateScoreForProject } = await import("../workers/scoreCalculator.js");
    await calculateScoreForProject(projectId);
    res.json({ success: true });
  } catch (err) {
    console.error("[calculate-score]", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
