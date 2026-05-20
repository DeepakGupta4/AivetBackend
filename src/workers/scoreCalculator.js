import { Project, PromptRun, VisibilityScore } from "../models/index.js";
import { calculateVisibility } from "../services/visibilityCalculator.js";

/**
 * Recompute today's visibility score for a project based on the last 24h of runs.
 */
export async function calculateScoreForProject(projectId) {
  const project = await Project.findById(projectId);
  if (!project) return;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const runs = await PromptRun.find({
    projectId,
    status: "completed",
    completedAt: { $gte: since },
  });

  const score = calculateVisibility(runs, project.brandName, project.domain);
  const scoreDate = new Date().toISOString().slice(0, 10);

  await VisibilityScore.findOneAndUpdate(
    { projectId, scoreDate },
    { projectId, scoreDate, ...score },
    { upsert: true, new: true }
  );

  console.log(`[score] ${project.name} ${scoreDate} = ${score.overallScore}`);
  return score;
}
