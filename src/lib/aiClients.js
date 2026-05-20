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
export async function generateCategoryPrompts({ brandName, domain, category }) {
  const cat = (category ?? "").trim() || "products";
  const fallback = [
    `Best ${cat} brands`,
    `Top ${cat} brands with affordable prices`,
    `Where can I buy the best ${cat} online?`,
    `Best ${cat} for gifting`,
    `Which ${cat} brand is most trusted?`,
    `Recommend top ${cat} brands for quality and durability`,
  ];
  if (!process.env.OPENAI_API_KEY) return fallback;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You generate buyer-intent search questions a shopper would ask an AI assistant to DISCOVER brands in a category. " +
              "The questions must NOT mention the given brand's name (we measure whether it appears on its own). " +
              "Cover discovery, comparison, best-for-gifting, where-to-buy, most-trusted, and affordable angles. Respond ONLY as JSON.",
          },
          {
            role: "user",
            content: `Brand: ${brandName}\nWebsite: ${domain}\nCategory: ${category || "infer from the website"}\n\nReturn JSON: {"prompts":["q1","q2","q3","q4","q5","q6"]}`,
          },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) return fallback;
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    const prompts = Array.isArray(parsed.prompts)
      ? parsed.prompts.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim()).slice(0, 8)
      : [];
    return prompts.length ? prompts : fallback;
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
