import { Campaign, PromptRun } from "../models/index.js";
import { availableCallers, extractMentionedBrands } from "../lib/aiClients.js";
import { calculateScoreForProject } from "./scoreCalculator.js";

// Convert an ordered list of recommended brands into mention records.
// Order in the list = ranking position. Detects the user's own brand.
function brandsToMentions(brands, brandName) {
  const own = (brandName ?? "").toLowerCase();
  const seen = new Set();
  const out = [];
  brands.forEach((b, i) => {
    const key = b.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const isOwn = !!own && (key === own || key.includes(own) || own.includes(key));
    out.push({
      entityName: isOwn ? brandName : b,
      entityType: isOwn ? "brand" : "competitor",
      mentionCount: 1,
      rankPosition: i + 1,
      sentiment: "neutral",
      sentimentScore: 0,
      confidence: 0.85,
      contextSnippet: "",
    });
  });
  return out;
}

// ── Mention extractor ─────────────────────────────────────────────────────
// Detects GENUINE entity mentions in an AI response. Crucially, it ignores
// "I don't know this brand" style answers so the score reflects real visibility
// instead of counting the brand name appearing in a disclaimer.
const ABSENT_PATTERNS = [
  "don't have", "do not have", "dont have", "not familiar", "no information",
  "not aware", "couldn't find", "could not find", "i don't know", "i do not know",
  "i'm not sure", "not enough information", "no specific information", "unable to find",
  "not a well-known", "doesn't appear", "does not appear", "i'm not familiar",
  "no data", "as of my last", "i cannot find", "can't find", "not recognized",
];
const POS_WORDS = ["best", "top", "leading", "excellent", "great", "popular", "recommended", "trusted", "reliable", "innovative", "high-quality", "quality", "love", "favorite", "powerful", "strong"];
const NEG_WORDS = ["worst", "bad", "poor", "scam", "avoid", "unreliable", "disappointing", "issue", "problem", "complaint", "negative", "lacks", "limited"];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param {string} text
 * @param {Array<{name:string,type:string}>} entities - brand + competitors
 */
function extractMentions(text, entities) {
  if (!text || !entities?.length) return [];
  const lower = text.toLowerCase();
  const out = [];

  for (const ent of entities) {
    const name = (ent.name ?? "").toLowerCase().trim();
    if (!name) continue;
    const idx = lower.indexOf(name);
    if (idx === -1) continue;

    // Skip if the brand only appears inside a "I don't know it" disclaimer.
    const win = lower.slice(Math.max(0, idx - 160), idx + 220);
    if (ABSENT_PATTERNS.some((p) => win.includes(p))) continue;

    const count = (lower.match(new RegExp(esc(name), "g")) ?? []).length;
    const rank = Math.max(1, Math.min(10, Math.floor((idx / Math.max(1, text.length)) * 10) + 1));

    let s = 0;
    for (const w of POS_WORDS) if (win.includes(w)) s += 0.2;
    for (const w of NEG_WORDS) if (win.includes(w)) s -= 0.25;
    s = Math.max(-1, Math.min(1, s));
    const sentiment = s > 0.15 ? "positive" : s < -0.15 ? "negative" : "neutral";

    out.push({
      entityName:     ent.name,
      entityType:     ent.type,
      mentionCount:   count,
      rankPosition:   rank,
      sentiment,
      sentimentScore: +s.toFixed(2),
      confidence:     0.6,
      contextSnippet: text.slice(Math.max(0, idx - 60), idx + 140),
    });
  }
  return out;
}

// Run `worker` over `items` with at most `limit` in flight at once. Prompts are
// independent, so processing them concurrently (instead of one-by-one) is the
// single biggest speedup for an audit — each prompt still fans out to all
// engines in parallel internally. `limit` is kept modest to respect provider
// rate limits (override with AUDIT_CONCURRENCY).
async function runPool(items, limit, worker) {
  const queue = items.map((item, idx) => [item, idx]);
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await worker(next[0], next[1]);
    }
  });
  await Promise.all(lanes);
}

// Hard cap on a single engine call. Node's fetch has NO default timeout, so a
// slow/hung provider (DataForSEO SERP, grounded search) could otherwise stall a
// whole concurrency lane indefinitely. Past this we give up on that one engine
// for that one prompt and keep going.
const ENGINE_TIMEOUT_MS = parseInt(process.env.ENGINE_TIMEOUT_MS ?? "30000", 10) || 30000;
function withTimeout(promise, ms = ENGINE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("engine timeout")), ms)),
  ]);
}

// Retry transient AI errors (429 rate-limit, 529/503 overload, timeouts).
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryable = /\b(429|529|503)\b|overload|rate.?limit|timeout|ETIMEDOUT|ECONNRESET/i.test(e.message ?? "");
      if (!retryable || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

function markBrandCitations(citations, brandDomain) {
  if (!brandDomain) return citations;
  const d = brandDomain.toLowerCase();
  return citations.map((c) => ({
    ...c,
    isBrandDomain: c.citedDomain?.toLowerCase().includes(d) ?? false,
  }));
}

// ── Main runner ───────────────────────────────────────────────────────────

export async function runCampaign(campaignId) {
  const campaign = await Campaign.findById(campaignId).populate("projectId");
  if (!campaign) return;

  const project   = campaign.projectId;
  const brandName = project?.brandName ?? "";
  const brandDomain = project?.domain ?? "";
  const entities = [
    { name: brandName, type: "brand" },
    ...(project?.competitors ?? []).map((c) => ({ name: c.brandName, type: "competitor" })),
  ];
  const activePrompts = campaign.prompts.filter((p) => p.isActive);
  const callers = availableCallers();

  if (!callers.length) {
    console.warn(`[campaign ${campaignId}] no AI engines configured`);
    return;
  }

  // Process one prompt: claim its pending run, fan out to all engines, extract
  // mentions/citations, and persist. Runs concurrently with other prompts.
  async function processPrompt(prompt) {
    const run = await PromptRun.findOneAndUpdate(
      { campaignId, promptText: prompt.text, status: "pending" },
      { status: "running", startedAt: new Date() },
      { new: true, sort: { createdAt: -1 } }
    );
    if (!run) return;

    try {
      const results = await Promise.allSettled(callers.map((fn) => withTimeout(withRetry(() => fn(prompt.text)))));
      const raw = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const responses = await Promise.all(raw.map(async (resp) => {
        let mentions;
        try {
          const brands = await extractMentionedBrands(resp.responseText);
          // null → no LLM key configured, fall back to the heuristic matcher.
          mentions = brands === null ? extractMentions(resp.responseText, entities) : brandsToMentions(brands, brandName);
        } catch {
          mentions = extractMentions(resp.responseText, entities);
        }
        return { ...resp, mentions, citations: markBrandCitations(resp.citations ?? [], brandDomain) };
      }));

      run.responses   = responses;
      run.status      = "completed";
      run.completedAt = new Date();
      await run.save();
    } catch (err) {
      run.status       = "failed";
      run.errorMessage = err.message;
      run.completedAt  = new Date();
      await run.save();
    }
  }

  const concurrency = Math.max(1, parseInt(process.env.AUDIT_CONCURRENCY ?? "8", 10) || 8);
  await runPool(activePrompts, concurrency, processPrompt);

  // Schedule next run
  const intervals = { hourly: 3600000, daily: 86400000, weekly: 604800000 };
  campaign.nextRunAt = new Date(Date.now() + (intervals[campaign.frequency] ?? 86400000));
  await campaign.save();

  // Recompute project score after the run finishes
  try {
    await calculateScoreForProject(project._id);
  } catch (err) {
    console.error("[score after campaign]", err);
  }

  console.log(`✅ Campaign ${campaignId} complete (${activePrompts.length} prompts × ${callers.length} engines, concurrency ${concurrency})`);
}
