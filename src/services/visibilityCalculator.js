/**
 * Pure functions to compute a project's visibility score from prompt runs.
 * Scores are 0-100. Weights mirror common AI-SEO scoring rubrics.
 */

const WEIGHTS = {
  mention:   0.30,
  ranking:   0.25,
  sentiment: 0.20,
  citation:  0.15,
  diversity: 0.10,
};

function clamp(n, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, n)); }

// Normalize a brand/entity name so "Levi's", "Levis" and "levi's" match.
function normName(s) {
  return (s ?? "")
    .toLowerCase()
    .replace(/['’`´]/g, "")
    .replace(/[.,/\\|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Names that count as "the brand": brand name + domain root (so a typo'd name
// like "amazom" still matches via amazon.com → "amazon").
function brandAliases(brandName, domain) {
  const set = new Set();
  const b = normName(brandName);
  if (b) set.add(b);
  const root = normName((domain ?? "").split(".")[0]);
  if (root.length >= 2) set.add(root);
  return [...set];
}

// Exact alias match OR a sub-brand ("Amazon Prime" counts for "Amazon").
function matchesBrand(entityName, aliases) {
  const e = normName(entityName);
  if (!e) return false;
  return aliases.some((a) => a && (e === a || e.startsWith(a + " ")));
}

/**
 * @param {Array} runs - PromptRun docs (each has .responses[].mentions)
 * @param {string} brandName
 * @param {string} brandDomain
 */
export function calculateVisibility(runs, brandName, brandDomain) {
  if (!runs.length) {
    return {
      overallScore: 0, mentionScore: 0, rankingScore: 0,
      sentimentScore: 0, citationScore: 0, diversityScore: 0,
      totalPrompts: 0, totalMentions: 0, modelsBreakdown: {},
    };
  }

  const aliases = brandAliases(brandName, brandDomain);
  const domain = brandDomain?.toLowerCase() ?? "";

  let totalResponses    = 0;
  let mentionedResponses = 0;
  const rankPositions   = [];
  const sentimentScores = [];
  let totalCitations    = 0;
  let brandCitations    = 0;
  const modelsBreakdown = {};
  const mentionedEngines = new Set();   // engines that ACTUALLY mention the brand
  let totalMentions     = 0;

  for (const run of runs) {
    for (const resp of run.responses ?? []) {
      totalResponses++;
      modelsBreakdown[resp.model] = (modelsBreakdown[resp.model] ?? 0) + 1;

      const brandMentions = (resp.mentions ?? []).filter(
        (m) => matchesBrand(m.entityName, aliases)
      );
      if (brandMentions.length) {
        mentionedResponses++;
        mentionedEngines.add(resp.model);
        totalMentions += brandMentions.reduce((s, m) => s + (m.mentionCount ?? 1), 0);
        for (const m of brandMentions) {
          if (m.rankPosition)   rankPositions.push(m.rankPosition);
          if (m.sentimentScore != null) sentimentScores.push(m.sentimentScore);
        }
      }

      for (const c of resp.citations ?? []) {
        totalCitations++;
        if (c.isBrandDomain || c.citedDomain?.toLowerCase().includes(domain)) {
          brandCitations++;
        }
      }
    }
  }

  // Mention score: % of responses that mention the brand
  const mentionScore = totalResponses ? (mentionedResponses / totalResponses) * 100 : 0;

  // Ranking score: lower rank position = better. Convert avg rank to 0-100.
  const avgRank = rankPositions.length
    ? rankPositions.reduce((a, b) => a + b, 0) / rankPositions.length
    : 0;
  const rankingScore = avgRank ? clamp(100 - (avgRank - 1) * 10) : 0;

  // Sentiment score: avg sentiment in [-1,1] mapped to 0-100.
  // No brand mentions → 0 (not a neutral 50, which would inflate an absent brand).
  const sentimentScore = sentimentScores.length
    ? clamp((sentimentScores.reduce((a, b) => a + b, 0) / sentimentScores.length + 1) * 50)
    : 0;

  // Citation score: % of citations pointing to brand domain
  const citationScore = totalCitations ? (brandCitations / totalCitations) * 100 : 0;

  // Diversity: across how many distinct engines the brand is actually mentioned
  // (NOT just how many engines responded — that inflated the score to non-zero
  // even when the brand never appeared). 5 engines max => 100.
  const diversityScore = clamp((mentionedEngines.size / 5) * 100);

  const overallScore = clamp(
    mentionScore   * WEIGHTS.mention   +
    rankingScore   * WEIGHTS.ranking   +
    sentimentScore * WEIGHTS.sentiment +
    citationScore  * WEIGHTS.citation  +
    diversityScore * WEIGHTS.diversity
  );

  return {
    overallScore:   +overallScore.toFixed(2),
    mentionScore:   +mentionScore.toFixed(2),
    rankingScore:   +rankingScore.toFixed(2),
    sentimentScore: +sentimentScore.toFixed(2),
    citationScore:  +citationScore.toFixed(2),
    diversityScore: +diversityScore.toFixed(2),
    totalPrompts:   runs.length,
    totalMentions,
    modelsBreakdown,
  };
}
