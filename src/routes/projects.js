import { Router } from "express";
import { Project, Team } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, notFoundError, validationError } from "../middleware/errorHandler.js";
import { projectLimiter } from "../middleware/rateLimiter.js";
import { validate, projectSchemas, validateObjectId } from "../middleware/validation.js";

const router = Router();
router.use(requireAuth);
router.use(projectLimiter);

async function getUserTeam(userId) {
  return Team.findOne({ "members.userId": userId });
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

  const { name, domain, brandName, industry, targetRegion, competitors } = req.body;

  const cleanCompetitors = Array.isArray(competitors)
    ? competitors
        .filter((c) => c && (c.brandName || c.domain))
        .map((c) => ({ brandName: c.brandName ?? "", domain: c.domain ?? "" }))
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
