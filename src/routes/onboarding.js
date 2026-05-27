import { Router } from "express";
import { Project, Team, Campaign, PromptRun } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { publishJob } from "../lib/qstash.js";
import { generateBusinessSummary, generateTopicPrompts } from "../lib/aiClients.js";
import { fetchKeywordIdeas } from "../lib/keywordData.js";
import { verifyDomainReachable } from "../lib/domainCheck.js";

const router = Router();
router.use(requireAuth);

function getUserTeam(userId) {
  return Team.findOne({ "members.userId": userId });
}

function cleanDomain(raw) {
  return String(raw || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

// POST /api/onboarding/analyze  { domain }
// Step 1 + 2 data: AI-generated business summary + suggested competitors.
router.post("/analyze", async (req, res) => {
  try {
    const domain = cleanDomain(req.body?.domain);
    if (!domain) return res.status(400).json({ success: false, message: "domain is required" });

    // Reachability gate — refuse non-existent / offline domains up front so we
    // never collect AI hallucinations about a brand whose site doesn't exist.
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

    const summary = await generateBusinessSummary({ domain });
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/onboarding/prompts  { brandName, domain, businessType, topics[], country, language }
// Step 3 data: topic clusters, each with 5-6 suggested prompts.
router.post("/prompts", async (req, res) => {
  try {
    const { brandName, domain, businessType, topics, country, language } = req.body ?? {};
    const clusters = await generateTopicPrompts({
      brandName: brandName || cleanDomain(domain),
      domain: cleanDomain(domain),
      businessType,
      topics,
      country,
      language,
    });
    res.json({ success: true, data: { clusters } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/onboarding/keywords  { domain, countryCode, languageCode }
// Step 4 data: real keyword ideas (search volume + difficulty) from DataForSEO.
router.post("/keywords", async (req, res) => {
  try {
    const { domain, countryCode, languageCode, topics, brandName } = req.body ?? {};
    const keywords = await fetchKeywordIdeas({
      domain: cleanDomain(domain),
      countryCode,
      languageCode,
      topics,
      brandName,
      limit: 25,
    });
    res.json({ success: true, data: { keywords } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/onboarding/complete
// Creates the project (with its business summary), a campaign from the selected
// prompts, and kicks off the first audit so visibility shows up immediately.
router.post("/complete", async (req, res) => {
  try {
    const team = await getUserTeam(req.user._id);
    if (!team) return res.status(404).json({ success: false, message: "Team not found" });

    const b = req.body ?? {};
    const domain = cleanDomain(b.domain);
    const brandName = (b.brandName || domain.split(".")[0] || "Brand").toString().trim();
    if (!domain) return res.status(400).json({ success: false, message: "domain is required" });

    // Defense-in-depth: even though /analyze gates this, re-check at /complete
    // so a direct API call can't slip a bad domain through.
    const reach = await verifyDomainReachable(domain);
    if (!reach.ok) {
      return res.status(400).json({
        success: false,
        code: "DOMAIN_UNREACHABLE",
        message: `Could not reach ${domain}. Please verify the website is online.`,
        data: { domain, reason: reach.reason },
      });
    }

    const competitors = Array.isArray(b.competitors)
      ? b.competitors
          .filter((c) => c && (c.brandName || c.domain))
          .map((c) => ({ brandName: (c.brandName || "").toString().trim(), domain: cleanDomain(c.domain) }))
          .slice(0, 10)
      : [];

    const keywords = Array.isArray(b.keywords)
      ? b.keywords
          .filter((k) => k && k.keyword)
          .map((k) => ({
            keyword: k.keyword.toString().trim(),
            searchVolume: Number(k.searchVolume) || 0,
            difficulty: Number(k.difficulty) || 0,
          }))
          .slice(0, 50)
      : [];

    const strArr = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()).slice(0, n) : []);

    const project = await Project.create({
      teamId: team._id,
      name: brandName,
      domain,
      brandName,
      industry: (b.businessType || "").toString().trim() || undefined,
      targetRegion: (b.country || "global").toString().trim(),
      competitors,
      businessType: (b.businessType || "").toString().trim(),
      language: (b.language || "English").toString().trim(),
      languageCode: (b.languageCode || "en").toString().trim().toLowerCase(),
      country: (b.country || "").toString().trim(),
      countryCode: (b.countryCode || "").toString().trim().toUpperCase().slice(0, 2),
      about: strArr(b.about, 4),
      competitiveAdvantage: (b.competitiveAdvantage || "").toString().trim(),
      keyFeatures: strArr(b.keyFeatures, 6),
      targetCustomers: strArr(b.targetCustomers, 6),
      topics: strArr(b.topics, 10),
      sitemaps: strArr(b.sitemaps, 10),
      keywords,
    });

    // Build the campaign from the user's selected prompts.
    const selected = Array.isArray(b.selectedPrompts)
      ? b.selectedPrompts
          .map((p) => (typeof p === "string" ? { text: p } : p))
          .filter((p) => p && typeof p.text === "string" && p.text.trim())
          .map((p) => ({
            text: p.text.trim().slice(0, 500),
            category: (p.category || "generic").toString().trim().slice(0, 50),
            intent: "commercial",
            isActive: true,
          }))
          .slice(0, 25)
      : [];

    let campaignId = null;
    if (selected.length) {
      const campaign = await Campaign.create({
        projectId: project._id,
        name: "AI Visibility Audit",
        description: "Prompts selected during onboarding",
        frequency: "weekly",
        isActive: true,
        nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        prompts: selected,
      });
      campaignId = campaign._id;

      await Promise.all(
        campaign.prompts.map((p) =>
          PromptRun.create({ campaignId: campaign._id, projectId: project._id, promptText: p.text, status: "pending" })
        )
      );

      // Kick off the first run now (inline when RUN_LOCAL=1, else via QStash).
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
    }

    res.status(201).json({ success: true, data: { project, campaignId } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
