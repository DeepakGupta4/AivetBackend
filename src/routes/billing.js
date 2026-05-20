import { Router } from "express";
import { getStripe, priceIdForPlan, PLAN_LIMITS } from "../lib/stripe.js";
import { Team, Subscription, Project, PromptRun } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// Accept canonical ids + the dixor "professional" alias → our internal "pro".
const PLAN_ALIASES = { starter: "starter", pro: "pro", professional: "pro", enterprise: "enterprise" };

// POST /api/billing/checkout — create Stripe checkout session
router.post("/checkout", async (req, res) => {
  try {
    const planKey = PLAN_ALIASES[String(req.body?.plan ?? "").toLowerCase()];
    const priceId = planKey ? priceIdForPlan(planKey) : null;
    if (!priceId) return res.status(400).json({ success: false, message: "Unknown plan" });

    const team = await Team.findOne({ "members.userId": req.user._id });
    if (!team) return res.status(404).json({ success: false, message: "No team found" });

    const stripe = getStripe();
    const sub = await Subscription.findOne({ teamId: team._id });

    // Redirect back to wherever the user actually is (localhost in dev, the real
    // domain in prod) — FRONTEND_URL points at the marketing site.
    const appUrl = req.headers.origin || process.env.APP_URL || (process.env.FRONTEND_URL || "").split(",")[0] || "http://localhost:3000";

    // Reuse a known Stripe customer if we have one; otherwise let Checkout create
    // it from the email. We deliberately avoid stripe.customers.create() so a
    // restricted key without `customer_write` still works (matches dt-backend).
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      ...(sub?.stripeCustomerId ? { customer: sub.stripeCustomerId } : { customer_email: req.user.email }),
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,                 // lets users enter coupon codes at checkout
      success_url: `${appUrl}/billing?status=success`,
      cancel_url:  `${appUrl}/pricing?status=canceled`,
      metadata: { teamId: team._id.toString(), plan: planKey },
    });

    res.json({ success: true, data: { url: session.url } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/billing/portal — Stripe customer portal session
router.post("/portal", async (req, res) => {
  try {
    const team = await Team.findOne({ "members.userId": req.user._id });
    const sub  = await Subscription.findOne({ teamId: team?._id });
    if (!sub?.stripeCustomerId) {
      return res.status(400).json({ success: false, message: "No Stripe customer yet" });
    }
    const stripe = getStripe();
    const appUrl = req.headers.origin || process.env.APP_URL || (process.env.FRONTEND_URL || "").split(",")[0] || "http://localhost:3000";
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${appUrl}/billing`,
    });
    res.json({ success: true, data: { url: session.url } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/billing/subscription — current sub + limits
router.get("/subscription", async (req, res) => {
  try {
    const team = await Team.findOne({ "members.userId": req.user._id });
    const sub  = await Subscription.findOne({ teamId: team?._id });
    const plan = sub?.plan ?? team?.plan ?? "free";

    // Usage: prompt runs in the last 30 days + active projects for this team.
    const projects = await Project.find({ teamId: team?._id, isActive: true }).select("_id");
    const projectIds = projects.map((p) => p._id);
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const promptsUsed = projectIds.length
      ? await PromptRun.countDocuments({ projectId: { $in: projectIds }, createdAt: { $gte: since } })
      : 0;

    res.json({
      success: true,
      data: {
        plan,
        status:            sub?.status            ?? "active",
        currentPeriodEnd:  sub?.currentPeriodEnd  ?? null,
        cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
        limits:            PLAN_LIMITS[plan],
        usage:             { promptsUsed, projectsUsed: projectIds.length },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
