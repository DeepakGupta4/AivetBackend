import { Router } from "express";
import { VisibilityScore, Project, PromptRun } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { buildRecommendations } from "../services/geoRecommendations.js";
import { getDomainAuthorities } from "../services/domainAuthority.js";

const router = Router();
router.use(requireAuth);

function getScoreBand(score) {
  if (score >= 80) return "DOMINANT";
  if (score >= 60) return "STRONG";
  if (score >= 40) return "BUILDING";
  if (score >= 20) return "WEAK";
  return "CRITICAL";
}

// Normalize a brand/entity name for matching so "Levi's", "Levis" and "levi's"
// all compare equal: lowercase, strip apostrophes, collapse punctuation/space.
function normName(s) {
  return (s ?? "")
    .toLowerCase()
    .replace(/['’`´]/g, "")
    .replace(/[.,/\\|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Build the set of names that count as "the brand": the brand name AND the
// domain's root (so a typo'd brand name like "amazom" still matches via
// amazon.com → "amazon"). Used with matchesBrand.
function brandAliases(brandName, domain) {
  const set = new Set();
  const b = normName(brandName);
  if (b) set.add(b);
  const root = normName((domain ?? "").split(".")[0]);
  if (root.length >= 2) set.add(root);
  return [...set];
}

// True if an entity is the brand: exact alias match OR a sub-brand of it
// (e.g. "Amazon Prime" counts for "Amazon").
function matchesBrand(entityName, aliases) {
  const e = normName(entityName);
  if (!e) return false;
  return aliases.some((a) => a && (e === a || e.startsWith(a + " ")));
}

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

// Percent change between two totals; 0 when there is no prior baseline.
function pctChange(recent, previous) {
  if (!previous) return recent > 0 ? 100 : 0;
  return round1(((recent - previous) / previous) * 100);
}

function timeAgo(date) {
  if (!date) return "";
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// GET /api/projects/:projectId/dashboard?days=30
router.get("/:projectId/dashboard", async (req, res) => {
  try {
    const { projectId } = req.params;
    const days = parseInt(req.query.days ?? "30", 10);

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split("T")[0];

    const [project, scores, runs] = await Promise.all([
      Project.findById(projectId).lean(),
      VisibilityScore.find({ projectId, scoreDate: { $gte: sinceStr } })
        .sort({ scoreDate: 1 })
        .lean(),
      PromptRun.find({ projectId, createdAt: { $gte: since } })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const brand = normName(project?.brandName);
    const aliases = brandAliases(project?.brandName, project?.domain);
    const brandDomain = (project?.domain ?? "").toLowerCase();
    const competitors = project?.competitors ?? [];

    // ── KPIs derived from the daily score docs ──────────────────────────────
    const latest = scores.at(-1) ?? null;
    const first = scores[0] ?? null;
    const currentScore = latest ? round1(latest.overallScore) : 0;
    const scoreChange = latest && first ? round1(latest.overallScore - first.overallScore) : 0;

    const totalPrompts = scores.reduce((s, x) => s + (x.totalPrompts ?? 0), 0);
    const totalMentions = scores.reduce((s, x) => s + (x.totalMentions ?? 0), 0);

    // Recent vs previous half of the window → trend badges on the KPI cards.
    const mid = Math.floor(scores.length / 2);
    const recent = scores.slice(mid);
    const prev = scores.slice(0, mid);
    const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] ?? 0), 0);
    const promptsChange = pctChange(sum(recent, "totalPrompts"), sum(prev, "totalPrompts"));
    const mentionsChange = pctChange(sum(recent, "totalMentions"), sum(prev, "totalMentions"));

    const mentionFrequency = latest?.mentionScore != null ? round1(latest.mentionScore) : 0;
    const mentionFreqChange =
      latest?.mentionScore != null && first?.mentionScore != null
        ? round1(latest.mentionScore - first.mentionScore)
        : 0;

    // ── Aggregate the period's prompt runs (responses → mentions/citations) ─
    let totalResponses = 0;
    let brandResponses = 0;   // responses where the brand (or a sub-brand) appears
    let citationsFound = 0;
    const modelStats = {};                 // model → { responses, mentioned, mentions }
    const entityResponses = {};            // entity (lower) → responses mentioning it
    const entityDisplay = {};              // entity (lower) → display name
    const recentMentions = [];

    for (const run of runs) {
      for (const resp of run.responses ?? []) {
        totalResponses++;
        const model = resp.model ?? "unknown";
        modelStats[model] ??= { responses: 0, mentioned: 0, mentions: 0 };
        modelStats[model].responses++;

        // Count citations of OUR brand (your domain), not every source cited.
        for (const c of resp.citations ?? []) {
          const dom = (c.citedDomain ?? "").toLowerCase();
          if (c.isBrandDomain || (brandDomain && dom.includes(brandDomain))) citationsFound++;
        }

        const mentions = resp.mentions ?? [];
        const seenEntities = new Set();
        let brandMention = null;
        let brandThisResp = false;
        for (const m of mentions) {
          const display = (m.entityName ?? "").trim();
          const name = normName(display);
          if (!name) continue;
          if (!entityDisplay[name]) entityDisplay[name] = display;
          if (!seenEntities.has(name)) {
            entityResponses[name] = (entityResponses[name] ?? 0) + 1;
            seenEntities.add(name);
          }
          if (matchesBrand(display, aliases)) {
            // Count the brand once per response (a response may name both
            // "Amazon" and "Amazon Prime").
            if (!brandThisResp) { modelStats[model].mentioned++; brandThisResp = true; }
            modelStats[model].mentions += m.mentionCount ?? 1;
            if (!brandMention) brandMention = m;
          }
        }
        if (brandThisResp) brandResponses++;

        // Build the "Recent Mentions" feed from responses that name the brand.
        if (brandMention && recentMentions.length < 8) {
          recentMentions.push({
            model,
            prompt: run.promptText ?? "",
            sentiment: brandMention.sentiment ?? "neutral",
            rank: brandMention.rankPosition ?? null,
            time: timeAgo(run.completedAt ?? run.createdAt),
          });
        }
      }
    }

    const modelsActive = Object.keys(modelStats).length;

    // Per-model visibility score = % of that model's responses mentioning brand
    const modelDistribution = Object.entries(modelStats).map(([model, s]) => ({
      model,
      score: s.responses ? Math.round((s.mentioned / s.responses) * 100) : 0,
      mentions: s.mentions,
    }));

    // Share of voice: brand + every brand DISCOVERED in answers, by mention freq.
    const pctOf = (lower) => (totalResponses ? Math.round(((entityResponses[lower] ?? 0) / totalResponses) * 100) : 0);
    const brandScore = totalResponses ? Math.round((brandResponses / totalResponses) * 100) : 0;
    const ownEntry = { brand: project?.brandName ?? "You", score: brandScore, isOwn: true };
    const discovered = Object.keys(entityResponses)
      .filter((lower) => !matchesBrand(lower, aliases))   // exclude the brand & its sub-brands
      .map((lower) => ({ brand: entityDisplay[lower] ?? lower, score: pctOf(lower), isOwn: false }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    const competitorShare = [ownEntry, ...discovered].sort((a, b) => b.score - a.score);
    // Count only competitors that appear in 2+ responses (filters one-off noise
    // from greedy brand extraction — otherwise a single audit shows 100s).
    const competitorsDiscovered = Object.keys(entityResponses).filter((l) => !matchesBrand(l, aliases) && entityResponses[l] >= 2).length;

    // ── Trend + latest score breakdown ─────────────────────────────────────
    const trend = scores.map((s) => ({
      scoreDate: s.scoreDate,
      overallScore: round1(s.overallScore),
      mentionScore: s.mentionScore ?? null,
      rankingScore: s.rankingScore ?? null,
      sentimentScore: s.sentimentScore ?? null,
      citationScore: s.citationScore ?? null,
      diversityScore: s.diversityScore ?? null,
      totalPrompts: s.totalPrompts ?? null,
      totalMentions: s.totalMentions ?? null,
      modelsBreakdown: s.modelsBreakdown ?? null,
    }));

    const scoreBreakdown = latest
      ? {
          mentionScore: latest.mentionScore ?? 0,
          rankingScore: latest.rankingScore ?? 0,
          sentimentScore: latest.sentimentScore ?? 0,
          citationScore: latest.citationScore ?? 0,
          diversityScore: latest.diversityScore ?? 0,
        }
      : null;

    res.json({
      success: true,
      data: {
        currentScore,
        scoreBand: getScoreBand(currentScore),
        scoreChange,
        kpis: {
          totalPrompts,
          totalMentions,
          mentionFrequency,
          citationsFound,
          competitorsTracked: competitorsDiscovered || competitors.length,
          modelsActive,
          promptsChange,
          mentionsChange,
          mentionFreqChange,
        },
        trend,
        modelDistribution,
        competitors: competitorShare,
        recentMentions,
        scoreBreakdown,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/projects/:projectId/visibility?days=30 — per-model breakdown
router.get("/:projectId/visibility", async (req, res) => {
  try {
    const { projectId } = req.params;
    const days = parseInt(req.query.days ?? "30", 10);
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split("T")[0];

    const [project, scores, runs] = await Promise.all([
      Project.findById(projectId).lean(),
      VisibilityScore.find({ projectId, scoreDate: { $gte: sinceStr } }).sort({ scoreDate: 1 }).lean(),
      PromptRun.find({ projectId, createdAt: { $gte: since } }).lean(),
    ]);

    const brand = normName(project?.brandName);
    const aliases = brandAliases(project?.brandName, project?.domain);
    const domain = (project?.domain ?? "").toLowerCase();

    const latest = scores.at(-1) ?? null;
    const first = scores[0] ?? null;
    const currentScore = latest ? round1(latest.overallScore) : 0;
    const scoreChange = latest && first ? round1(latest.overallScore - first.overallScore) : 0;

    const midTime = since.getTime() + (Date.now() - since.getTime()) / 2;
    const blank = () => ({ responses: 0, mentioned: 0, mentions: 0, ranks: [], sentiments: [], cites: 0, brandCites: 0, topRank: Infinity, topPrompt: "" });
    const agg = {}, recent = {}, prev = {};

    for (const run of runs) {
      const isRecent = new Date(run.createdAt).getTime() >= midTime;
      for (const resp of run.responses ?? []) {
        const model = resp.model ?? "unknown";
        const A = (agg[model] ??= blank());
        const H = isRecent ? (recent[model] ??= blank()) : (prev[model] ??= blank());
        A.responses++; H.responses++;

        const brandMentions = (resp.mentions ?? []).filter((m) => matchesBrand(m.entityName, aliases));
        if (brandMentions.length) {
          A.mentioned++; H.mentioned++;
          for (const m of brandMentions) {
            A.mentions += m.mentionCount ?? 1;
            if (m.rankPosition) {
              A.ranks.push(m.rankPosition); H.ranks.push(m.rankPosition);
              if (m.rankPosition < A.topRank) { A.topRank = m.rankPosition; A.topPrompt = run.promptText; }
            }
            if (m.sentimentScore != null) { A.sentiments.push(m.sentimentScore); H.sentiments.push(m.sentimentScore); }
          }
        }
        for (const c of resp.citations ?? []) {
          A.cites++; H.cites++;
          if (c.isBrandDomain || (domain && (c.citedDomain ?? "").toLowerCase().includes(domain))) { A.brandCites++; H.brandCites++; }
        }
      }
    }

    const factorsOf = (A) => {
      const mention = A.responses ? (A.mentioned / A.responses) * 100 : 0;
      const avgRank = A.ranks.length ? A.ranks.reduce((a, b) => a + b, 0) / A.ranks.length : 0;
      const ranking = avgRank ? clamp(100 - (avgRank - 1) * 10) : 0;
      const avgSent = A.sentiments.length ? A.sentiments.reduce((a, b) => a + b, 0) / A.sentiments.length : 0;
      const sentiment = A.sentiments.length ? clamp((avgSent + 1) * 50) : 0;
      const citation = A.cites ? (A.brandCites / A.cites) * 100 : 0;
      return { mention, ranking, sentiment, citation };
    };
    const scoreOf = (f) => Math.round(f.mention * 0.35 + f.ranking * 0.30 + f.sentiment * 0.20 + f.citation * 0.15);
    const sentLabel = (A) => {
      const avg = A.sentiments.length ? A.sentiments.reduce((a, b) => a + b, 0) / A.sentiments.length : 0;
      return avg > 0.2 ? "positive" : avg < -0.15 ? "negative" : "neutral";
    };

    const models = Object.entries(agg).map(([model, A]) => {
      const f = factorsOf(A);
      const score = scoreOf(f);
      const rPrev = prev[model] ? scoreOf(factorsOf(prev[model])) : null;
      const rRecent = recent[model] ? scoreOf(factorsOf(recent[model])) : null;
      const change = rPrev != null && rRecent != null ? rRecent - rPrev : 0;
      return {
        model,
        score,
        mentions: A.mentions,
        change,
        sentiment: sentLabel(A),
        topPrompt: A.topPrompt || null,
        factors: {
          mention: Math.round(f.mention),
          ranking: Math.round(f.ranking),
          sentiment: Math.round(f.sentiment),
          citation: Math.round(f.citation),
        },
      };
    }).sort((a, b) => b.score - a.score);

    const trend = scores.map((s) => ({
      scoreDate: s.scoreDate,
      overallScore: round1(s.overallScore),
      totalMentions: s.totalMentions ?? 0,
    }));

    res.json({
      success: true,
      data: { currentScore, scoreBand: getScoreBand(currentScore), scoreChange, trend, models },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/projects/:projectId/competitor-analysis?days=30
router.get("/:projectId/competitor-analysis", async (req, res) => {
  try {
    const { projectId } = req.params;
    const days = parseInt(req.query.days ?? "30", 10);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [project, runs] = await Promise.all([
      Project.findById(projectId).lean(),
      PromptRun.find({ projectId, createdAt: { $gte: since } }).lean(),
    ]);

    const brandName = project?.brandName ?? "";
    const brandLower = normName(brandName);

    // Discover every brand that appears in answers (+ the brand + configured competitors).
    const display = new Map(); // normalized → display name
    if (brandName) display.set(brandLower, brandName);
    for (const c of project?.competitors ?? []) if (c.brandName) display.set(normName(c.brandName), c.brandName);

    const models = new Set();
    let totalResponses = 0;
    const stat = {}; // lower → { mentions, responses, perModel }
    const ensure = (l) => (stat[l] ??= { mentions: 0, responses: 0, perModel: {} });
    const modelResponses = {};

    for (const run of runs) {
      for (const resp of run.responses ?? []) {
        totalResponses++;
        const model = resp.model ?? "unknown";
        models.add(model);
        modelResponses[model] = (modelResponses[model] ?? 0) + 1;

        const seen = new Set();
        for (const m of resp.mentions ?? []) {
          const nm = (m.entityName ?? "").trim();
          if (!nm) continue;
          const lower = normName(nm);
          if (!display.has(lower)) display.set(lower, nm);
          if (seen.has(lower)) continue;
          seen.add(lower);
          const s = ensure(lower);
          s.responses++;
          s.mentions += m.mentionCount ?? 1;
          s.perModel[model] = (s.perModel[model] ?? 0) + 1;
        }
      }
    }

    const modelList = [...models];
    const isOwn = (l) => !!brandLower && (l === brandLower || l.includes(brandLower) || brandLower.includes(l));

    const all = [...display.entries()].map(([lower, name]) => {
      const s = stat[lower] ?? { mentions: 0, responses: 0, perModel: {} };
      const perModel = {};
      for (const model of modelList) {
        perModel[model] = modelResponses[model] ? Math.round(((s.perModel[model] ?? 0) / modelResponses[model]) * 100) : 0;
      }
      return { name, isOwn: isOwn(lower), score: totalResponses ? Math.round((s.responses / totalResponses) * 100) : 0, mentions: s.mentions, perModel };
    });

    // Always include the brand; show top competitors actually found.
    const ownRows = all.filter((e) => e.isOwn);
    const others = all.filter((e) => !e.isOwn && e.mentions > 0).sort((a, b) => b.score - a.score).slice(0, 15);
    const result = [...ownRows, ...others].sort((a, b) => b.score - a.score);

    res.json({ success: true, data: { brandName, models: modelList, entities: result } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/projects/:projectId/citations?days=30
router.get("/:projectId/citations", async (req, res) => {
  try {
    const { projectId } = req.params;
    const days = parseInt(req.query.days ?? "30", 10);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [project, runs] = await Promise.all([
      Project.findById(projectId).lean(),
      PromptRun.find({ projectId, createdAt: { $gte: since } }).lean(),
    ]);

    const domain = (project?.domain ?? "").toLowerCase();
    // citedDomain → { count, brand, authoritySum, models:Set }
    const map = {};
    let total = 0;
    let brandTotal = 0;

    for (const run of runs) {
      for (const resp of run.responses ?? []) {
        const model = resp.model ?? "unknown";
        for (const c of resp.citations ?? []) {
          const dom = (c.citedDomain ?? "").toLowerCase();
          if (!dom) continue;
          total++;
          const isBrand = c.isBrandDomain || (domain && dom.includes(domain));
          if (isBrand) brandTotal++;
          const e = (map[dom] ??= { domain: dom, count: 0, isBrand, authoritySum: 0, authorityN: 0, models: new Set() });
          e.count++;
          e.isBrand = e.isBrand || isBrand;
          if (c.authorityScore) { e.authoritySum += c.authorityScore; e.authorityN++; }
          e.models.add(model);
        }
      }
    }

    const sources = Object.values(map)
      .map((e) => ({
        domain: e.domain,
        count: e.count,
        isBrand: e.isBrand,
        authority: 0,
        models: [...e.models],
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // Real domain authority (DataForSEO Labs, cached) for the shown sources.
    const authMap = await getDomainAuthorities(sources.map((s) => s.domain));
    for (const s of sources) s.authority = authMap[s.domain] ?? 0;

    // "Opportunities": high-frequency external domains the brand could target.
    const opportunities = sources.filter((s) => !s.isBrand).slice(0, 6);

    res.json({
      success: true,
      data: {
        totalCitations: total,
        brandCitations: brandTotal,
        brandShare: total ? Math.round((brandTotal / total) * 100) : 0,
        uniqueDomains: Object.keys(map).length,
        sources,
        opportunities,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/projects/:projectId/geo?days=30 — computed GEO recommendations
router.get("/:projectId/geo", async (req, res) => {
  try {
    const { projectId } = req.params;
    const days = parseInt(req.query.days ?? "30", 10);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [project, latest, runs] = await Promise.all([
      Project.findById(projectId).lean(),
      VisibilityScore.findOne({ projectId }).sort({ scoreDate: -1 }).lean(),
      PromptRun.find({ projectId, createdAt: { $gte: since } }).lean(),
    ]);

    // Brand vs top-competitor share of voice (for the gap recommendation).
    const aliases = brandAliases(project?.brandName, project?.domain);
    const shareCount = {};
    for (const c of project?.competitors ?? []) shareCount[normName(c.brandName)] = 0;
    let totalResponses = 0, brandResponses = 0;
    for (const run of runs) {
      for (const resp of run.responses ?? []) {
        totalResponses++;
        const seen = new Set();
        let brandThisResp = false;
        for (const m of resp.mentions ?? []) {
          if (matchesBrand(m.entityName, aliases)) brandThisResp = true;
          const n = normName(m.entityName);
          if (shareCount[n] == null || seen.has(n)) continue;
          seen.add(n);
          shareCount[n]++;
        }
        if (brandThisResp) brandResponses++;
      }
    }
    const pct = (n) => (totalResponses ? Math.round((n / totalResponses) * 100) : 0);
    const brandShare = pct(brandResponses);
    let topCompetitor = null, topShare = 0;
    for (const c of project?.competitors ?? []) {
      const sh = pct(shareCount[normName(c.brandName)] ?? 0);
      if (sh > topShare) { topShare = sh; topCompetitor = c.brandName; }
    }
    const competitorGap = topShare > brandShare ? topShare - brandShare : 0;

    const recommendations = buildRecommendations(latest, {
      brandName: project?.brandName,
      topCompetitor,
      competitorGap,
    });
    const counts = { high: 0, medium: 0, low: 0 };
    recommendations.forEach((r) => { counts[r.priority]++; });

    res.json({ success: true, data: { recommendations, counts, hasData: !!latest } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/projects/:projectId/scores/latest
router.get("/:projectId/scores/latest", async (req, res) => {
  try {
    const score = await VisibilityScore.findOne({ projectId: req.params.projectId }).sort({ scoreDate: -1 });
    if (!score) return res.status(404).json({ success: false, message: "No scores yet" });
    res.json({ success: true, data: score });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
