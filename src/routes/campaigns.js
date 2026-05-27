import { Router } from "express";
import { Campaign, PromptRun, Project, Team, Subscription } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { publishJob } from "../lib/qstash.js";
import { generateCategoryPrompts } from "../lib/aiClients.js";
import { PLAN_LIMITS } from "../lib/stripe.js";

const router = Router();
router.use(requireAuth);

function formatCooldown(ms) {
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.ceil(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"}`;
  return `${Math.ceil(h / 24)} day${Math.ceil(h / 24) === 1 ? "" : "s"}`;
}

// Per-plan audit prompt budget — free preview is capped so a one-click audit
// finishes in seconds (3 prompts × 5 engines) rather than nearly a minute.
const AUDIT_PROMPT_BUDGET = { free: 3, starter: 6, pro: 8, enterprise: 8 };

// Per-plan auto re-run cadence. Matches the billing copy: Starter weekly,
// Business + Enterprise daily, Free monthly (kept very slow so the cron
// queue doesn't bill us for unpaid users).
const AUDIT_CADENCE = {
  free:       { frequency: "weekly", nextMs: 30 * 24 * 60 * 60 * 1000 },
  starter:    { frequency: "weekly", nextMs: 7  * 24 * 60 * 60 * 1000 },
  pro:        { frequency: "daily",  nextMs: 24 * 60 * 60 * 1000 },
  enterprise: { frequency: "daily",  nextMs: 24 * 60 * 60 * 1000 },
};

// Minimum gap between manual audits on the same brand. Stops accidental
// double-clicks and abuse (each audit fans out to 5 LLM engines per prompt,
// so cost is non-trivial). Tier-aware: paid users iterate faster.
const AUDIT_COOLDOWN_MS = {
  free:       24 * 60 * 60 * 1000, // 24 hours
  starter:    60 * 60 * 1000,      // 1 hour
  pro:        15 * 60 * 1000,      // 15 minutes
  enterprise: 5  * 60 * 1000,      // 5 minutes
};

async function planForUser(userId) {
  const team = await Team.findOne({ "members.userId": userId });
  if (!team) return "free";
  const sub = await Subscription.findOne({ teamId: team._id });
  return sub?.plan ?? team.plan ?? "free";
}

// POST /api/campaigns/audit — one-click AI-visibility audit for a brand.
// Auto-generates category questions, creates a campaign, and runs it now.
router.post("/audit", async (req, res) => {
  try {
    const { projectId, category } = req.body;
    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ success: false, message: "Project not found" });

    const plan = await planForUser(req.user._id);
    const maxPrompts = AUDIT_PROMPT_BUDGET[plan] ?? 3;

    // 1. Per-brand audit gate — three states:
    //    a) An audit is currently running for this brand → tell user to wait,
    //       don't trigger a second one (would burn LLM credits for nothing).
    //    b) A recent audit completed within the tier's cooldown window → block
    //       with a friendly message that the data is ready to view.
    //    c) Otherwise → run it.
    //    Onboarding kicks off the very first audit automatically, so brand-new
    //    brands almost always land here — the message acknowledges that.
    const cooldownMs = AUDIT_COOLDOWN_MS[plan] ?? AUDIT_COOLDOWN_MS.free;
    const inFlight = await PromptRun.findOne({
      projectId,
      status: { $in: ["pending", "running"] },
    }).select("_id").lean();
    if (inFlight) {
      return res.status(409).json({
        success: false,
        code: "AUDIT_IN_PROGRESS",
        message: `An audit is already running for ${project.brandName}. It usually finishes in 15-30 seconds — refresh in a moment.`,
        data: { brandName: project.brandName },
      });
    }

    const recentCampaign = await Campaign.findOne({ projectId })
      .sort({ createdAt: -1 })
      .select("createdAt")
      .lean();
    if (recentCampaign) {
      const elapsed = Date.now() - new Date(recentCampaign.createdAt).getTime();
      if (elapsed < cooldownMs) {
        const remainingMs = cooldownMs - elapsed;
        // Differentiate copy: if onboarding-initiated and very recent, frame it
        // as "we already did this for you"; otherwise it's a real cooldown.
        const wasOnboardingAudit = elapsed < 5 * 60 * 1000; // first 5 min after creation
        const message = wasOnboardingAudit
          ? `We just finished your first audit for ${project.brandName} — open the Overview to see your visibility data. You can run another audit in ${formatCooldown(remainingMs)}.`
          : `${project.brandName} was just audited — next audit on this brand in ${formatCooldown(remainingMs)}. Your other brands can still run audits.`;
        return res.status(429).json({
          success: false,
          code: "AUDIT_COOLDOWN",
          message,
          data: {
            plan,
            brandName: project.brandName,
            cooldownMs,
            remainingMs,
            nextAvailableAt: new Date(Date.now() + remainingMs).toISOString(),
            wasOnboardingAudit,
          },
        });
      }
    }

    // 2. Monthly prompt budget — hard cap that matches the billing copy
    //    ("250 / 500 / 1,000 prompts/month"). Prevents runaway LLM cost.
    const promptLimit = PLAN_LIMITS[plan]?.promptLimit ?? 50;
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const team = await Team.findOne({ "members.userId": req.user._id });
    const teamProjectIds = team
      ? (await Project.find({ teamId: team._id, isActive: true }).select("_id").lean()).map((p) => p._id)
      : [projectId];
    const promptsUsed = await PromptRun.countDocuments({ projectId: { $in: teamProjectIds }, createdAt: { $gte: since } });
    const wouldUse = promptsUsed + maxPrompts;
    if (wouldUse > promptLimit) {
      return res.status(429).json({
        success: false,
        code: "MONTHLY_LIMIT_REACHED",
        message: `You've used ${promptsUsed} of ${promptLimit} prompts this month on your ${plan} plan. Upgrade for more headroom.`,
        data: { plan, promptLimit, promptsUsed, wouldUse },
      });
    }

    const prompts = await generateCategoryPrompts({
      brandName: project.brandName,
      domain: project.domain,
      category: category ?? project.industry,
      maxPrompts,
      extraContext: {
        about: project.about,
        keyFeatures: project.keyFeatures,
        country: project.country,
        targetRegion: project.targetRegion,
      },
    });

    // Persist category on the project for future audits.
    if (category && category !== project.industry) {
      project.industry = category;
      await project.save();
    }

    const cadence = AUDIT_CADENCE[plan] ?? AUDIT_CADENCE.free;
    const campaign = await Campaign.create({
      projectId: project._id,
      name: "AI Visibility Audit",
      description: "Auto-generated audit across AI engines",
      frequency: cadence.frequency,
      isActive: true,
      nextRunAt: new Date(Date.now() + cadence.nextMs),
      prompts: prompts.map((text) => ({ text, category: "generic", intent: "commercial", isActive: true })),
    });

    await Promise.all(
      campaign.prompts.map((p) =>
        PromptRun.create({ campaignId: campaign._id, projectId: project._id, promptText: p.text, status: "pending" })
      )
    );

    await publishJob(
      "/api/webhooks/run-campaign",
      { campaignId: campaign._id.toString() },
      {
        runLocal: async () => {
          const { runCampaign } = await import("../workers/campaignRunner.js");
          await runCampaign(campaign._id.toString());
        },
      }
    );

    res.status(202).json({ success: true, data: { campaignId: campaign._id, prompts, promptCount: prompts.length } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/campaigns?projectId=xxx
router.get("/", async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ success: false, message: "projectId required" });
    const campaigns = await Campaign.find({ projectId });
    res.json({ success: true, data: campaigns });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/campaigns
router.post("/", async (req, res) => {
  try {
    const { projectId, name, description, frequency, prompts } = req.body;
    const nextRunAt = new Date(Date.now() + 60 * 60 * 1000); // +1h
    const campaign = await Campaign.create({ projectId, name, description, frequency, prompts, nextRunAt });
    res.status(201).json({ success: true, data: campaign });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/campaigns/:id
router.put("/:id", async (req, res) => {
  try {
    const campaign = await Campaign.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, data: campaign });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/campaigns/:id
router.delete("/:id", async (req, res) => {
  try {
    await Campaign.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/campaigns/:id/run — trigger a run (queues via QStash, or inline locally)
router.post("/:id/run", async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });

    // Create one pending PromptRun per active prompt
    const pendingRuns = await Promise.all(
      campaign.prompts.filter((p) => p.isActive).map((p) =>
        PromptRun.create({
          campaignId: campaign._id,
          projectId:  campaign.projectId,
          promptText: p.text,
          status:     "pending",
        })
      )
    );

    await publishJob(
      "/api/webhooks/run-campaign",
      { campaignId: campaign._id.toString() },
      {
        runLocal: async () => {
          const { runCampaign } = await import("../workers/campaignRunner.js");
          await runCampaign(campaign._id.toString());
        },
      }
    );

    res.status(202).json({ success: true, data: { queued: pendingRuns.length } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/campaigns/:id/runs
router.get("/:id/runs", async (req, res) => {
  try {
    const runs = await PromptRun.find({ campaignId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ success: true, data: runs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
