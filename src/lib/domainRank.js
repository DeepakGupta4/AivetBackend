/**
 * Domain authority via DataForSEO Labs "bulk traffic estimation".
 * The account has Labs access (not Backlinks), so we derive a 0-100 authority
 * from estimated organic traffic value (etv) on a log scale.
 */

// etv ranges from ~hundreds to hundreds of millions → log10 maps it to 0-100.
function etvToAuthority(etv) {
  if (!etv || etv <= 0) return 0;
  const a = Math.round(((Math.log10(etv) - 2) / 7) * 100); // log10 2→9 maps 0→100
  return Math.max(1, Math.min(100, a));
}

/**
 * @param {string[]} domains
 * @returns {Promise<Record<string,{authority:number, etv:number}>>}
 */
export async function fetchDomainAuthorities(domains) {
  const targets = [...new Set(domains.map((d) => d.toLowerCase()).filter(Boolean))].slice(0, 1000);
  if (!targets.length || !process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) return {};

  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString("base64");
  const res = await fetch("https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_traffic_estimation/live", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify([{ targets, location_code: 2840, language_code: "en" }]),
  });
  const data = await res.json();
  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];

  const out = {};
  for (const it of items) {
    const etv = it.metrics?.organic?.etv ?? 0;
    out[(it.target ?? "").toLowerCase()] = { etv, authority: etvToAuthority(etv) };
  }
  return out;
}
