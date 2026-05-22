/**
 * Keyword ideas with search volume + SEO difficulty via DataForSEO Labs.
 *
 * Relevance matters: a brand's "keywords to track" must be about the brand and
 * its category — not generic high-volume noise. We therefore combine two Labs
 * endpoints and drop `keywords_for_site` (which returned irrelevant top-volume
 * terms like "sarkari result" for a jewellery site):
 *   1. ranked_keywords  → the keywords the domain ACTUALLY ranks for (brand +
 *      brand-adjacent terms, exactly like the reference tool shows).
 *   2. keyword_ideas     → category keywords seeded from the brand's topics
 *      (clean, on-topic suggestions with volume + difficulty).
 * Brand-specific terms are surfaced first, then on-topic ideas, then the rest.
 */

// ISO 3166-1 alpha-2 → DataForSEO location_code (country level).
const LOCATION_CODES = {
  US: 2840, IN: 2356, GB: 2826, UK: 2826, CA: 2124, AU: 2036,
  DE: 2276, FR: 2250, ES: 2724, IT: 2380, NL: 2528, BR: 2076,
  MX: 2484, JP: 2392, SG: 2702, AE: 2784, ZA: 2710, ID: 2360,
  PK: 2586, BD: 2050, NG: 2566, PH: 2608, MY: 2458, SA: 2682,
};

export function locationCodeFor(countryCode) {
  const cc = String(countryCode || "").trim().toUpperCase();
  return LOCATION_CODES[cc] ?? 2840; // default United States
}

function fmtVolume(n) {
  if (!n || n < 1000) return String(n ?? 0);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1).replace(/\.0$/, "")}M`;
}

function authHeader() {
  return "Basic " + Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString("base64");
}

async function dfs(path, body) {
  const res = await fetch(`https://api.dataforseo.com/v3/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.tasks?.[0]?.result?.[0]?.items ?? [];
}

function normalize(keyword, info, props, market) {
  const searchVolume = info?.search_volume ?? 0;
  return {
    keyword: String(keyword || "").trim(),
    searchVolume,
    searchVolumeLabel: fmtVolume(searchVolume),
    difficulty: Math.round(props?.keyword_difficulty ?? 0),
    market,
  };
}

/**
 * @param {object} args
 * @param {string} args.domain
 * @param {string} [args.countryCode]
 * @param {string} [args.languageCode]
 * @param {string[]} [args.topics]      seeds for category keyword ideas
 * @param {string} [args.brandName]     used to surface brand-specific terms first
 * @param {number} [args.limit]
 */
export async function fetchKeywordIdeas({ domain, countryCode = "US", languageCode = "en", topics = [], brandName = "", limit = 25 }) {
  const target = String(domain || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!target || !process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) return [];

  const locationCode = locationCodeFor(countryCode);
  const lang = String(languageCode || "en").trim().toLowerCase() || "en";
  const market = `${lang.toUpperCase()}-${String(countryCode || "US").toUpperCase()}`;
  const seeds = (Array.isArray(topics) ? topics : []).filter((t) => typeof t === "string" && t.trim()).slice(0, 10);

  // Fire both lookups in parallel; tolerate either failing.
  const [rankedItems, ideaItems] = await Promise.all([
    dfs("dataforseo_labs/google/ranked_keywords/live", [{
      target, location_code: locationCode, language_code: lang, limit: 40,
      order_by: ["keyword_data.keyword_info.search_volume,desc"],
    }]).catch(() => []),
    seeds.length
      ? dfs("dataforseo_labs/google/keyword_ideas/live", [{
          keywords: seeds, location_code: locationCode, language_code: lang, limit: 40,
          order_by: ["keyword_info.search_volume,desc"],
          filters: [["keyword_info.search_volume", ">", 0]],
        }]).catch(() => [])
      : Promise.resolve([]),
  ]);

  const ranked = rankedItems
    .map((it) => { const k = it.keyword_data || it; return normalize(k.keyword, k.keyword_info, k.keyword_properties, market); })
    .filter((k) => k.keyword && k.searchVolume > 0);
  const ideas = ideaItems
    .map((it) => normalize(it.keyword, it.keyword_info, it.keyword_properties, market))
    .filter((k) => k.keyword && k.searchVolume > 0);

  const byVol = (a, b) => b.searchVolume - a.searchVolume;
  const pool = [...ranked, ...ideas];
  const lc = (k) => k.keyword.toLowerCase();

  // Collapse near-duplicate variants ("gold ring for women" / "ladies gold ring"
  // / "gold rings for woman" …) to one signature: drop stopwords, fold gender
  // synonyms, singularize, sort tokens.
  const STOP = new Set(["for", "in", "the", "a", "of", "to", "and", "with", "on", "at", "your", "best", "near", "me"]);
  const GENDER = { woman: "women", womans: "women", womens: "women", ladies: "women", lady: "women", female: "women", females: "women", girl: "women", girls: "women", men: "men", man: "men", mans: "men", mens: "men", male: "men", boy: "men", boys: "men" };
  const sig = (kw) => {
    const toks = kw.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)
      .filter((t) => !STOP.has(t))
      .map((t) => GENDER[t] || t)
      .map((t) => (t.endsWith("s") && t.length > 3 ? t.slice(0, -1) : t));
    return [...new Set(toks)].sort().join(" ");
  };

  const brandToken = String(brandName || target.split(".")[0] || "").toLowerCase().trim();
  const isBrand = (kw) => brandToken.length >= 3 && kw.includes(brandToken);

  // Commodity price/rate queries ("gold price today", "22 carat gold rate") are
  // category-adjacent but flood by volume and aren't useful brand keywords — keep
  // only a few. Product/category terms are the real signal.
  const isCommodity = (kw) => /\b(price|rate|mcx|carat|tola)\b/.test(kw) || /(today|live)\s+(gold|silver)|(gold|silver)\s+(today|price|rate)/.test(kw);
  const PRODUCT_WORDS = ["ring", "earring", "necklace", "bracelet", "jewell", "jewel", "mangalsutra", "pendant", "chain", "bangle", "anklet", "nose pin", "nosepin", "diamond", "platinum", "gift", "engagement", "wedding", "bridal", "stud", "jhumka", "kada", "nath", "payal", "brooch", "solitaire", "gold ", "silver "];
  const isProduct = (kw) => PRODUCT_WORDS.some((w) => kw.includes(w));

  const brandTerms = pool.filter((k) => isBrand(lc(k))).sort(byVol);
  const products = pool.filter((k) => !isBrand(lc(k)) && isProduct(lc(k)) && !isCommodity(lc(k))).sort(byVol);
  const commodity = pool.filter((k) => !isBrand(lc(k)) && isCommodity(lc(k))).sort(byVol);
  const others = pool.filter((k) => !isBrand(lc(k)) && !isProduct(lc(k)) && !isCommodity(lc(k))).sort(byVol);

  // Order: brand terms → product/category keywords → a few commodity → filler.
  const seen = new Set();
  const out = [];
  const push = (arr, cap = Infinity) => {
    let n = 0;
    for (const k of arr) {
      if (out.length >= limit || n >= cap) break;
      const key = sig(k.keyword) || lc(k);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(k);
      n++;
    }
  };
  push(brandTerms);
  push(products);
  push(commodity, 3);
  // Only top up with the brand's other (non-product) ranked terms if we're short
  // on relevant keywords — avoids padding a good list with noise.
  if (out.length < 10) push(others, 10 - out.length);
  return out;
}
