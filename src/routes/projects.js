import { Router } from "express";
import { Project, Team, Subscription } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, notFoundError, validationError } from "../middleware/errorHandler.js";
import { projectLimiter } from "../middleware/rateLimiter.js";
import { validate, projectSchemas, validateObjectId } from "../middleware/validation.js";
import { PLAN_LIMITS } from "../lib/stripe.js";
import { verifyDomainReachable } from "../lib/domainCheck.js";

const router = Router();
router.use(requireAuth);
router.use(projectLimiter);

async function getUserTeam(userId) {
  return Team.findOne({ "members.userId": userId });
}

async function planForTeam(team) {
  const sub = await Subscription.findOne({ teamId: team._id });
  return sub?.plan ?? team?.plan ?? "free";
}

// GET /api/projects
router.get("/", asyncHandler(async (req, res) => {
  const team = await getUserTeam(req.user._id);
  if (!team) throw notFoundError('Team');

  const projects = await Project.find({ teamId: team._id, isActive: true });
  res.json({ success: true, data: projects });
}));

// POST /api/projects
router.post("/", validate(projectSchemas.create), asyncHandler(async (req, res) => {
  const team = await getUserTeam(req.user._id);
  if (!team) throw notFoundError('Team');

  // Plan-based projectLimit guard. Free tier (Ubersuggest-style preview) allows
  // exactly 1 brand; paid tiers raise the cap. Block at the boundary so the UI
  // can prompt for an upgrade instead of silently letting brands pile up.
  const plan = await planForTeam(team);
  const projectLimit = PLAN_LIMITS[plan]?.projectLimit ?? 1;
  const activeCount = await Project.countDocuments({ teamId: team._id, isActive: true });
  if (activeCount >= projectLimit) {
    return res.status(403).json({
      success: false,
      code: "PROJECT_LIMIT_REACHED",
      message: `Your ${plan} plan allows ${projectLimit} brand${projectLimit === 1 ? "" : "s"}. Upgrade to add more.`,
      data: { plan, projectLimit, projectsUsed: activeCount },
    });
  }

  const { name, domain, brandName, industry, targetRegion, competitors } = req.body;

  // Reachability check — reject domains that don't resolve / don't respond.
  // Without this, AI engines hallucinate brand answers for a name that shares
  // the project's brand and produce meaningless visibility scores (ziva.in
  // case where the domain doesn't exist but AIVET happily tracked "ziva").
  const reach = await verifyDomainReachable(domain);
  if (!reach.ok) {
    return res.status(400).json({
      success: false,
      code: "DOMAIN_UNREACHABLE",
      message:
        reach.reason === "dns_not_found"
          ? `Could not reach ${domain} — the domain does not appear to exist. Check the URL and try again.`
          : reach.reason === "timeout"
          ? `Could not reach ${domain} — the site timed out. Check the URL or try again later.`
          : `Could not reach ${domain}. Please verify the website is online.`,
      data: { domain, reason: reach.reason },
    });
  }

  // Cap the initial competitors[] at the tier's per-brand competitor limit so
  // bulk creation can't bypass the runtime cap.
  const competitorLimit = PLAN_LIMITS[plan]?.competitorLimit ?? 3;
  const cleanCompetitors = Array.isArray(competitors)
    ? competitors
        .filter((c) => c && (c.brandName || c.domain))
        .map((c) => ({ brandName: c.brandName ?? "", domain: c.domain ?? "" }))
        .slice(0, competitorLimit)
    : [];

  const project = await Project.create({
    teamId: team._id,
    name,
    domain,
    brandName,
    industry,
    targetRegion,
    competitors: cleanCompetitors,
  });

  res.status(201).json({ success: true, data: project });
}));

// PUT /api/projects/:id
router.put("/:id", validateObjectId(), validate(projectSchemas.update), asyncHandler(async (req, res) => {
  const project = await Project.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!project) throw notFoundError('Project');
  
  res.json({ success: true, data: project });
}));

// DELETE /api/projects/:id
router.delete("/:id", async (req, res) => {
  try {
    await Project.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/projects/:id/competitors
router.post("/:id/competitors", async (req, res) => {
  try {
    const { domain, brandName } = req.body;

    // Plan-based competitor cap. Block before push so the UI can prompt for an
    // upgrade instead of silently allowing more competitors than the plan
    // promises. Free 3, Starter 5, Business 10, Enterprise 15.
    const team = await getUserTeam(req.user._id);
    const plan = team ? await planForTeam(team) : "free";
    const competitorLimit = PLAN_LIMITS[plan]?.competitorLimit ?? 3;
    const current = await Project.findById(req.params.id).select("competitors").lean();
    const currentCount = (current?.competitors ?? []).length;
    if (currentCount >= competitorLimit) {
      return res.status(403).json({
        success: false,
        code: "COMPETITOR_LIMIT_REACHED",
        message: `Your ${plan} plan allows ${competitorLimit} competitor${competitorLimit === 1 ? "" : "s"} per brand. Upgrade to add more.`,
        data: { plan, competitorLimit, competitorsUsed: currentCount },
      });
    }

    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { $push: { competitors: { domain, brandName } } },
      { new: true }
    );
    res.json({ success: true, data: project.competitors });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/projects/:id/competitors
router.get("/:id/competitors", async (req, res) => {
  try {
    const project = await Project.findById(req.params.id).select("competitors");
    res.json({ success: true, data: project?.competitors ?? [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/projects/:id/competitors/:competitorId
router.delete("/:id/competitors/:competitorId", async (req, res) => {
  try {
    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { $pull: { competitors: { _id: req.params.competitorId } } },
      { new: true }
    );
    res.json({ success: true, data: project?.competitors ?? [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
