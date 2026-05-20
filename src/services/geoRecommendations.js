/**
 * Derives GEO (Generative Engine Optimization) recommendations from a project's
 * latest visibility sub-scores. Pure function — no DB access.
 */
function priorityFor(score) {
  if (score < 40) return "high";
  if (score < 65) return "medium";
  return "low";
}

const RANK = { high: 0, medium: 1, low: 2 };

/**
 * @param {object} score - latest VisibilityScore-like object (sub-scores 0-100)
 * @param {object} ctx   - { brandName, topCompetitor?, competitorGap?, citationShare? }
 */
export function buildRecommendations(score, ctx = {}) {
  const brand = ctx.brandName ?? "your brand";
  const recs = [];
  const s = {
    mention: score?.mentionScore ?? 0,
    ranking: score?.rankingScore ?? 0,
    sentiment: score?.sentimentScore ?? 0,
    citation: score?.citationScore ?? 0,
    diversity: score?.diversityScore ?? 0,
  };

  if (s.mention < 75) {
    recs.push({
      type: "content_gap",
      priority: priorityFor(s.mention),
      title: "Increase brand mention frequency",
      description: `${brand} appears in only ${Math.round(s.mention)}% of relevant AI answers. Publish comparison and "best tools" content so engines surface you more often.`,
      impact: 88, effort: 55,
      actionItems: [
        "Create listicle/comparison pages targeting your top prompts",
        "Add your brand to relevant industry roundups & directories",
        "Publish use-case pages that match common buyer questions",
      ],
    });
  }

  if (s.citation < 65) {
    recs.push({
      type: "entity",
      priority: priorityFor(s.citation),
      title: "Earn more authoritative citations",
      description: `Only ${Math.round(s.citation)}% of cited sources point to your domain. Citation-driven engines (Perplexity, Google AI) reward authoritative, linkable content.`,
      impact: 82, effort: 60,
      actionItems: [
        "Publish original research / data studies worth citing",
        "Get featured on G2, Capterra and industry publications",
        "Add clear, quotable statistics to key pages",
      ],
    });
  }

  if (s.ranking < 70) {
    recs.push({
      type: "topical",
      priority: priorityFor(s.ranking),
      title: "Improve ranking position in AI answers",
      description: `Your average position in AI responses can improve. Strengthen topical authority around your core themes.`,
      impact: 76, effort: 55,
      actionItems: [
        "Build topic clusters around your primary keywords",
        "Improve depth and freshness of cornerstone content",
        "Interlink related pages to reinforce topical relevance",
      ],
    });
  }

  if (s.sentiment < 78) {
    recs.push({
      type: "faq",
      priority: priorityFor(s.sentiment),
      title: "Strengthen positive sentiment",
      description: `Shape how AI describes ${brand} by surfacing strengths, testimonials and clear answers to objections.`,
      impact: 64, effort: 40,
      actionItems: [
        "Publish customer success stories & testimonials",
        "Add an FAQ addressing common objections",
        "Encourage positive reviews on third-party sites",
      ],
    });
  }

  if (s.diversity < 80) {
    recs.push({
      type: "ai_friendly",
      priority: priorityFor(s.diversity),
      title: "Expand presence across more AI engines",
      description: `You're not equally visible on every engine. Diversify content formats so ChatGPT, Gemini, Claude and Perplexity all surface you.`,
      impact: 68, effort: 45,
      actionItems: [
        "Ensure content is crawlable and well-structured",
        "Cover both informational and commercial intent queries",
        "Maintain an up-to-date public knowledge base",
      ],
    });
  }

  if (ctx.competitorGap > 0 && ctx.topCompetitor) {
    recs.push({
      type: "content_gap",
      priority: ctx.competitorGap > 15 ? "high" : "medium",
      title: `Close the visibility gap with ${ctx.topCompetitor}`,
      description: `${ctx.topCompetitor} currently outranks ${brand} by ${ctx.competitorGap} points of share-of-voice. Target the prompts where they win.`,
      impact: 80, effort: 60,
      actionItems: [
        `Analyze prompts where ${ctx.topCompetitor} is mentioned and you aren't`,
        "Create head-to-head comparison content",
        "Double down on your differentiators in key pages",
      ],
    });
  }

  // Always-useful baseline recs
  recs.push({
    type: "schema",
    priority: "medium",
    title: "Add structured data & schema markup",
    description: "Schema.org markup (Organization, Product, FAQ) helps AI engines understand and cite your pages accurately.",
    impact: 70, effort: 30,
    actionItems: [
      "Add Organization & Product schema to key pages",
      "Mark up FAQs with FAQPage schema",
      "Validate with Google's Rich Results test",
    ],
  });

  return recs
    .map((r, i) => ({ id: `rec-${i + 1}`, ...r }))
    .sort((a, b) => RANK[a.priority] - RANK[b.priority] || b.impact - a.impact);
}
