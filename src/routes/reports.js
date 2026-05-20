import { Router } from "express";
import { marked } from "marked";
import { Project, VisibilityScore, PromptRun } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { htmlToPdf } from "../lib/pdf.js";

const router = Router();
router.use(requireAuth);

function buildReportHtml({ project, latestScore, recentRuns }) {
  const date = new Date().toISOString().slice(0, 10);
  const overview = `
## ${project.name}
**Domain:** ${project.domain}
**Brand:** ${project.brandName}
**Industry:** ${project.industry ?? "—"}
**Generated:** ${date}

## Visibility Snapshot
- **Overall Score:** ${latestScore?.overallScore ?? 0}
- **Mentions:** ${latestScore?.mentionScore ?? 0}
- **Ranking:** ${latestScore?.rankingScore ?? 0}
- **Sentiment:** ${latestScore?.sentimentScore ?? 0}
- **Citations:** ${latestScore?.citationScore ?? 0}
- **Diversity:** ${latestScore?.diversityScore ?? 0}

## Recent Prompt Runs (${recentRuns.length})
${recentRuns.map((r) => `- _${r.promptText}_ — **${r.status}** (${r.responses?.length ?? 0} engines)`).join("\n")}
`;
  const bodyHtml = marked.parse(overview);
  return `
    <!doctype html>
    <html><head><meta charset="utf-8" />
      <title>${project.name} — AIVet Report</title>
      <style>
        body { font-family: -apple-system, system-ui, sans-serif; color: #222; max-width: 720px; margin: 0 auto; padding: 32px; }
        h1, h2 { color: #111; }
        h2 { border-bottom: 1px solid #eee; padding-bottom: 6px; margin-top: 28px; }
        ul { padding-left: 20px; }
        li { margin: 4px 0; }
        .header { display:flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #111; padding-bottom: 12px; }
        .brand { font-weight: 700; font-size: 18px; }
      </style>
    </head><body>
      <div class="header">
        <div class="brand">AIVet</div>
        <div>${date}</div>
      </div>
      ${bodyHtml}
    </body></html>
  `;
}

// GET /api/reports/projects/:id/pdf
router.get("/projects/:id/pdf", async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ success: false, message: "Project not found" });

    const [latestScore, recentRuns] = await Promise.all([
      VisibilityScore.findOne({ projectId: project._id }).sort({ scoreDate: -1 }),
      PromptRun.find({ projectId: project._id }).sort({ createdAt: -1 }).limit(20),
    ]);

    const html = buildReportHtml({ project, latestScore, recentRuns });
    const pdf  = await htmlToPdf(html);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="aivet-${project.domain.replace(/[^a-z0-9]/gi, "-")}.pdf"`
    );
    res.send(pdf);
  } catch (err) {
    console.error("[reports/pdf]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
