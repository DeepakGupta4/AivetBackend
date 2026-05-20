import { DomainAuthority } from "../models/index.js";
import { fetchDomainAuthorities } from "../lib/domainRank.js";

const STALE_MS = 30 * 24 * 60 * 60 * 1000; // refresh authority at most monthly

/**
 * Return { domain: authority(0-100) } for the given domains, using a Mongo cache
 * and only calling DataForSEO for domains that are missing or stale (cost-saving).
 */
export async function getDomainAuthorities(domains) {
  const uniq = [...new Set(domains.map((d) => (d ?? "").toLowerCase()).filter(Boolean))];
  if (!uniq.length) return {};

  const cached = await DomainAuthority.find({ domain: { $in: uniq } }).lean();
  const map = {};
  const fresh = new Set();
  for (const c of cached) {
    map[c.domain] = c.authority;
    if (Date.now() - new Date(c.updatedAt).getTime() < STALE_MS) fresh.add(c.domain);
  }

  const missing = uniq.filter((d) => !fresh.has(d));
  if (missing.length) {
    try {
      const fetched = await fetchDomainAuthorities(missing);
      const ops = [];
      for (const d of missing) {
        const v = fetched[d] ?? { authority: 0, etv: 0 };
        map[d] = v.authority;
        ops.push({ updateOne: { filter: { domain: d }, update: { $set: { domain: d, authority: v.authority, etv: v.etv } }, upsert: true } });
      }
      if (ops.length) await DomainAuthority.bulkWrite(ops, { ordered: false });
    } catch (err) {
      console.error("[domainAuthority]", err.message);
    }
  }
  return map;
}
