/**
 * Keyword ideas with search volume + SEO difficulty via DataForSEO Labs.
 *
 * Uses the "keywords_for_site" endpoint, which returns the keywords a domain
 * already ranks for — exactly the brand-relevant terms shown in the onboarding
 * "Keywords to track" step (e.g. amazon.com → "prime video", "aws", …), each
 * with real monthly search volume and a 0-100 keyword difficulty.
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

/**
 * @param {object} args
 * @param {string} args.domain
 * @param {string} [args.countryCode]   ISO alpha-2, e.g. "IN"
 * @param {string} [args.languageCode]  ISO 639-1, e.g. "en"
 * @param {number} [args.limit]
 * @returns {Promise<Array<{ keyword:string, searchVolume:number, searchVolumeLabel:string, difficulty:number, market:string }>>}
 */
export async function fetchKeywordIdeas({ domain, countryCode = "US", languageCode = "en", limit = 25 }) {
  const target = String(domain || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!target || !process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) return [];

  const locationCode = locationCodeFor(countryCode);
  const lang = String(languageCode || "en").trim().toLowerCase() || "en";
  const market = `${lang.toUpperCase()}-${String(countryCode || "US").toUpperCase()}`;

  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString("base64");
  try {
    const res = await fetch("https://api.dataforseo.com/v3/dataforseo_labs/google/keywords_for_site/live", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify([{
        target,
        location_code: locationCode,
        language_code: lang,
        limit: Math.min(Math.max(limit, 1), 100),
        order_by: ["keyword_info.search_volume,desc"],
        filters: [["keyword_info.search_volume", ">", 0]],
      }]),
    });
    const data = await res.json();
    const items = data.tasks?.[0]?.result?.[0]?.items ?? [];

    const seen = new Set();
    const out = [];
    for (const it of items) {
      const keyword = (it.keyword ?? "").toString().trim();
      if (!keyword || seen.has(keyword)) continue;
      seen.add(keyword);
      const searchVolume = it.keyword_info?.search_volume ?? 0;
      const difficulty = it.keyword_properties?.keyword_difficulty ?? 0;
      out.push({
        keyword,
        searchVolume,
        searchVolumeLabel: fmtVolume(searchVolume),
        difficulty: Math.round(difficulty),
        market,
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}
