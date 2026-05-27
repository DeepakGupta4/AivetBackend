/**
 * REST clients for all AI engines. No SDKs — just fetch().
 * Each function returns: { model, provider, responseText, tokensUsed, latencyMs, citations? }
 */

export async function callOpenAI(prompt, opts = {}) {
  const start = Date.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: opts.model ?? "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: opts.maxTokens ?? 1024,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message ?? "unknown"}`);
  return {
    model: "chatgpt",
    provider: "openai",
    responseText: data.choices?.[0]?.message?.content ?? "",
    tokensUsed:   data.usage?.total_tokens ?? 0,
    latencyMs:    Date.now() - start,
  };
}

export async function callClaude(prompt, opts = {}) {
  const start = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":     "application/json",
      "x-api-key":         process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-haiku-4-5-20251001",
      max_tokens: opts.maxTokens ?? 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${data?.error?.message ?? "unknown"}`);
  return {
    model: "claude",
    provider: "anthropic",
    responseText: data.content?.[0]?.text ?? "",
    tokensUsed:   (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    latencyMs:    Date.now() - start,
  };
}

export async function callGemini(prompt, opts = {}) {
  const start = Date.now();
  const model = opts.model ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data?.error?.message ?? "unknown"}`);
  return {
    model: "gemini",
    provider: "google",
    responseText: data.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
    tokensUsed:   data.usageMetadata?.totalTokenCount ?? 0,
    latencyMs:    Date.now() - start,
  };
}

/**
 * Perplexity-style engine powered by Gemini + Google Search grounding.
 * Returns web-grounded answers with real source citations, using GEMINI_API_KEY.
 * Labelled `perplexity` so it fills the Perplexity slot in the dashboard.
 */
export async function callGeminiGrounded(prompt, opts = {}) {
  const start = Date.now();
  const model = opts.model ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Perplexity(gemini-grounded) ${res.status}: ${data?.error?.message ?? "unknown"}`);

  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join("");
  const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
  const citations = chunks
    .filter((c) => c.web?.uri)
    .map((c) => {
      // Gemini grounding hides the real URL behind a vertexaisearch redirect, but
      // exposes the source domain/title in `web.title` — prefer that for display.
      const title = (c.web.title ?? "").toLowerCase();
      let domain = title;
      if (!/\.[a-z]{2,}/.test(title)) {
        try {
          const h = new URL(c.web.uri).hostname.replace(/^www\./, "");
          if (!h.includes("vertexaisearch")) domain = h;
        } catch { /* keep title */ }
      }
      return { citedUrl: c.web.uri, citedDomain: domain, isBrandDomain: false, authorityScore: 0 };
    });

  return {
    model: "perplexity",
    provider: "google-grounded",
    responseText: text,
    tokensUsed: data.usageMetadata?.totalTokenCount ?? 0,
    latencyMs: Date.now() - start,
    citations,
  };
}

export async function callPerplexity(prompt, opts = {}) {
  const start = Date.now();
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${process.env.PERPLEXITY_API_KEY}`,
    },
    body: JSON.stringify({
      model: opts.model ?? "llama-3.1-sonar-small-128k-online",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Perplexity ${res.status}: ${data?.error?.message ?? "unknown"}`);
  const citations = (data.citations ?? []).map((url) => {
    try {
      const u = new URL(url);
      return { citedUrl: url, citedDomain: u.hostname, isBrandDomain: false, authorityScore: 0 };
    } catch { return { citedUrl: url, citedDomain: "", isBrandDomain: false, authorityScore: 0 }; }
  });
  return {
    model: "perplexity",
    provider: "perplexity",
    responseText: data.choices?.[0]?.message?.content ?? "",
    tokensUsed:   data.usage?.total_tokens ?? 0,
    latencyMs:    Date.now() - start,
    citations,
  };
}

/**
 * Google AI Overviews via DataForSEO SERP API.
 * Returns the AI Overview block when present for a query.
 */
export async function callGoogleAIOverview(prompt, opts = {}) {
  const start = Date.now();
  const login = process.env.DATAFORSEO_LOGIN;
  const pass  = process.env.DATAFORSEO_PASSWORD;
  if (!login || !pass) throw new Error("DataForSEO credentials missing");

  const auth = Buffer.from(`${login}:${pass}`).toString("base64");
  const res = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify([{
      keyword:       prompt,
      language_code: opts.lang     ?? "en",
      location_code: opts.location ?? 2840, // United States
      device:        "desktop",
    }]),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`DataForSEO ${res.status}`);

  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];
  const ai = items.find((i) => i.type === "ai_overview");
  const text = ai?.text ?? ai?.markdown ?? items
    .filter((i) => i.type === "organic")
    .slice(0, 3)
    .map((i) => `${i.title}\n${i.description}`)
    .join("\n\n");
  const refs = ai?.references ?? [];
  const citations = refs.map((r) => ({
    citedUrl:       r.url,
    citedDomain:    r.domain,
    isBrandDomain:  false,
    authorityScore: 0,
  }));

  return {
    model: "google_ai_overview",
    provider: "google",
    responseText: text ?? "",
    tokensUsed:   0,
    latencyMs:    Date.now() - start,
    citations,
  };
}

/**
 * Extract the brand/company names an AI answer actually RECOMMENDS or lists as
 * options (in order = ranking). Excludes brands the answer says it doesn't know.
 * This is how visibility is measured honestly: we look at category questions and
 * see which brands surface — not whether the model recognizes a brand by name.
 * Returns string[] of brand names, or null if no extractor key is configured.
 */
export async function extractMentionedBrands(text) {
  if (!text || !text.trim()) return [];
  if (!process.env.OPENAI_API_KEY) return null; // signal caller to fall back

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You analyze an AI assistant's answer to a shopping/recommendation question. " +
            "List the distinct BRAND, COMPANY or STORE names the answer actually recommends or presents as real options, " +
            "in the order they appear (that order is their ranking). " +
            "EXCLUDE any brand the answer says it has no information about, doesn't recognize, can't find, or is unsure about. " +
            "EXCLUDE generic words (e.g. 'jewelry', 'online stores'). Respond ONLY as JSON.",
        },
        { role: "user", content: `Answer:\n"""${text.slice(0, 4000)}"""\n\nReturn JSON: {"brands":["Name1","Name2"]}` },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`extractBrands ${res.status}: ${data?.error?.message ?? "unknown"}`);
  try {
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    return Array.isArray(parsed.brands)
      ? parsed.brands.filter((b) => typeof b === "string" && b.trim()).map((b) => b.trim()).slice(0, 15)
      : [];
  } catch {
    return [];
  }
}

/**
 * Generate buyer-intent CATEGORY questions for an audit (no brand name in them —
 * that's the point: measure if the brand surfaces on its own). LLM-generated from
 * the brand's category, with a template fallback.
 */
// maxPrompts lets paid tiers see the full 8-question audit while free preview
// is capped at 3 so the audit finishes ~3x faster.
// extraContext (about[], keyFeatures[]) is woven into the user message so the
// generator stays glued to the brand's actual category instead of drifting to
// adjacent niches (e.g. a fitness-equipment brand should not produce sneaker
// or supplement prompts — that's what made the earlier ziva.in audit look like
// it was reaching across unrelated industries).
export async function generateCategoryPrompts({ brandName, domain, category, maxPrompts = 8, extraContext = {} }) {
  const cap = Math.max(1, Math.min(8, maxPrompts | 0 || 8));
  const cat = (category ?? "").trim() || "products";
  const fallback = [
    `Best ${cat} brands`,
    `Top ${cat} brands with affordable prices`,
    `Where can I buy the best ${cat} online?`,
    `Best ${cat} for gifting`,
    `Which ${cat} brand is most trusted?`,
    `Recommend top ${cat} brands for quality and durability`,
  ].slice(0, cap);
  if (!process.env.OPENAI_API_KEY) return fallback;

  const about = Array.isArray(extraContext.about) ? extraContext.about.filter((s) => typeof s === "string" && s.trim()).slice(0, 4) : [];
  const features = Array.isArray(extraContext.keyFeatures) ? extraContext.keyFeatures.filter((s) => typeof s === "string" && s.trim()).slice(0, 4) : [];
  const region = (extraContext.country || extraContext.targetRegion || "").toString().trim();

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You generate buyer-intent search questions a shopper would ask an AI assistant to DISCOVER brands in a SPECIFIC category. " +
              "STRICT RULES: " +
              "(1) Every question must be tightly scoped to the exact category provided — never drift to adjacent or unrelated niches. " +
              "(2) Do NOT mention the given brand's name (we measure whether it appears on its own). " +
              "(3) Cover discovery, comparison, best-for-gifting, where-to-buy, most-trusted, and affordable angles WITHIN the category. " +
              "(4) Use the region/country if provided to make questions locally relevant. " +
              "Respond ONLY as JSON.",
          },
          {
            role: "user",
            content:
              `Brand: ${brandName}\n` +
              `Website: ${domain}\n` +
              `Category: ${category || "infer from the website"}\n` +
              (region ? `Region: ${region}\n` : "") +
              (about.length ? `About: ${about.join("; ")}\n` : "") +
              (features.length ? `Key offerings: ${features.join("; ")}\n` : "") +
              `\nReturn up to ${cap} prompts as JSON: {"prompts":["q1","q2"]}`,
          },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) return fallback;
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    const prompts = Array.isArray(parsed.prompts)
      ? parsed.prompts.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim()).slice(0, cap)
      : [];
    return prompts.length ? prompts : fallback;
  } catch {
    return fallback;
  }
}

// ── Onboarding: business analysis & topic-grouped prompts ──────────────────

/**
 * Fetch a website's homepage and return a cleaned plain-text excerpt.
 * Best-effort: returns "" on any failure (the LLM then works from brand knowledge).
 */
export async function fetchSiteText(domain, { maxChars = 6000, timeoutMs = 9000 } = {}) {
  const clean = String(domain || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!clean) return "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${clean}`, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AIVetBot/1.0; +https://aivet.io)" },
    });
    if (!res.ok) return "";
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, maxChars);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Analyze a brand/domain and return a structured "business summary" used to
 * pre-fill the onboarding wizard: brand name, business type, language/location,
 * about, competitive advantage, key features, target customers, topics, and
 * suggested competitors. Fetches the homepage for grounding; falls back to the
 * model's own knowledge when the site can't be read.
 */
export async function generateBusinessSummary({ domain }) {
  const cleanDomain = String(domain || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const guessName = cleanDomain.split(".")[0]
    ? cleanDomain.split(".")[0].charAt(0).toUpperCase() + cleanDomain.split(".")[0].slice(1)
    : "Brand";

  const fallback = {
    brandName: guessName,
    domain: cleanDomain,
    businessType: "",
    language: "English",
    languageCode: "en",
    country: "United States",
    countryCode: "US",
    about: [],
    competitiveAdvantage: "",
    keyFeatures: [],
    targetCustomers: [],
    topics: [],
    competitors: [],
  };
  if (!process.env.OPENAI_API_KEY) return fallback;

  const siteText = await fetchSiteText(cleanDomain);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 1100,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a market analyst building a business profile for an AI-visibility (GEO/SEO) tool. " +
              "Given a website domain and an excerpt of its homepage text, produce a concise, accurate profile. " +
              "Infer the brand's primary market language and country from the content/TLD. " +
              "Topics are short search-style themes (3-6 words) a user might explore about this brand or its category. " +
              "Competitors are real, well-known rival companies in the SAME market and country. " +
              "Respond ONLY as JSON.",
          },
          {
            role: "user",
            content:
              `Domain: ${cleanDomain}\n` +
              `Homepage excerpt: """${siteText || "(could not fetch — use your own knowledge of this brand/domain)"}"""\n\n` +
              `Return JSON with EXACTLY these keys:\n` +
              `{\n` +
              `  "brandName": "string",\n` +
              `  "businessType": "short label e.g. 'E-commerce & Technology'",\n` +
              `  "language": "primary market language name e.g. 'English'",\n` +
              `  "languageCode": "ISO 639-1 e.g. 'en'",\n` +
              `  "country": "primary market country name e.g. 'India'",\n` +
              `  "countryCode": "ISO 3166-1 alpha-2 e.g. 'IN'",\n` +
              `  "about": ["2-3 short bullet sentences about the business"],\n` +
              `  "competitiveAdvantage": "1-2 sentence summary",\n` +
              `  "keyFeatures": ["3-5 short bullets, each 'Name: description'"],\n` +
              `  "targetCustomers": ["3-5 short bullets"],\n` +
              `  "topics": ["10 short search-style topics"],\n` +
              `  "competitors": [{"brandName":"string","domain":"rival.com"}]  // 4-6 real rivals\n` +
              `}`,
          },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) return fallback;
    const p = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
    return {
      brandName: (p.brandName || guessName).toString().trim(),
      domain: cleanDomain,
      businessType: (p.businessType || "").toString().trim(),
      language: (p.language || "English").toString().trim(),
      languageCode: (p.languageCode || "en").toString().trim().toLowerCase(),
      country: (p.country || "United States").toString().trim(),
      countryCode: (p.countryCode || "US").toString().trim().toUpperCase().slice(0, 2),
      about: arr(p.about).slice(0, 4),
      competitiveAdvantage: (p.competitiveAdvantage || "").toString().trim(),
      keyFeatures: arr(p.keyFeatures).slice(0, 6),
      targetCustomers: arr(p.targetCustomers).slice(0, 6),
      topics: arr(p.topics).slice(0, 10),
      competitors: Array.isArray(p.competitors)
        ? p.competitors
            .filter((c) => c && (c.brandName || c.domain))
            .map((c) => ({
              brandName: (c.brandName || "").toString().trim(),
              domain: (c.domain || "").toString().trim().toLowerCase()
                .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
            }))
            .slice(0, 8)
        : [],
    };
  } catch {
    return fallback;
  }
}

/**
 * For each topic, generate a cluster of natural user questions (prompts) that
 * track the brand's visibility in AI assistants. Returns an array of
 * { topic, prompts: string[] } — typically 5-6 prompts per topic.
 */
export async function generateTopicPrompts({ brandName, domain, businessType, topics, country, language }) {
  const list = (Array.isArray(topics) ? topics : []).filter((t) => typeof t === "string" && t.trim()).slice(0, 8);
  if (!list.length) return [];

  const loc = country && !/global/i.test(country) ? ` in ${country}` : "";
  const fallback = list.map((topic) => ({
    topic,
    prompts: [
      `What are the best brands for ${topic}${loc}?`,
      `Which ${topic} brands are most recommended${loc}?`,
      `Where can I buy ${topic}${loc} online?`,
      `What should I look for when choosing ${topic}${loc}?`,
      `Compare the top brands for ${topic}${loc}.`,
    ],
  }));
  if (!process.env.OPENAI_API_KEY) return fallback;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.5,
        max_tokens: 1600,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You generate realistic questions a user would type into ChatGPT or Gemini, grouped by topic, " +
              "to measure a brand's visibility in AI answers. For each topic produce 5-6 distinct, natural questions. " +
              "Mix discovery/comparison questions (where the brand may or may not surface on its own) with a few " +
              "brand- or category-specific questions. Keep each question under 140 characters. " +
              `CRITICAL: localize EVERY question to the brand's market country (${country || "the brand's country"}) so locally-relevant brands surface — ` +
              `phrase them the way real customers in ${country || "that country"} search, including "in ${country || "that country"}" where natural. ` +
              "Avoid purely global phrasing that would only return big international brands. Respond ONLY as JSON.",
          },
          {
            role: "user",
            content:
              `Brand: ${brandName}\nWebsite: ${domain}\nBusiness type: ${businessType || "infer"}\n` +
              `Market: ${language || "English"} / ${country || "global"}\n` +
              `Topics: ${JSON.stringify(list)}\n\n` +
              `Return JSON: {"clusters":[{"topic":"<one of the topics verbatim>","prompts":["q1","q2","q3","q4","q5"]}]}`,
          },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) return fallback;
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    const clusters = Array.isArray(parsed.clusters)
      ? parsed.clusters
          .map((c) => ({
            topic: (c.topic || "").toString().trim(),
            prompts: Array.isArray(c.prompts)
              ? c.prompts.filter((q) => typeof q === "string" && q.trim()).map((q) => q.trim()).slice(0, 6)
              : [],
          }))
          .filter((c) => c.topic && c.prompts.length)
      : [];
    return clusters.length ? clusters : fallback;
  } catch {
    return fallback;
  }
}

/** Return the list of caller functions whose env vars are set. */
export function availableCallers() {
  const callers = [];
  if (process.env.OPENAI_API_KEY)                                       callers.push(callOpenAI);
  if (process.env.ANTHROPIC_API_KEY)                                    callers.push(callClaude);
  if (process.env.GEMINI_API_KEY)                                       callers.push(callGemini);
  // Perplexity slot: native key if provided, else Gemini + Google Search grounding.
  if (process.env.PERPLEXITY_API_KEY)                                   callers.push(callPerplexity);
  else if (process.env.GEMINI_API_KEY)                                  callers.push(callGeminiGrounded);
  if (process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD)  callers.push(callGoogleAIOverview);
  return callers;
}
