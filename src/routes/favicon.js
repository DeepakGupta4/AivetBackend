import { Router } from "express";

const router = Router();

// In-memory cache so we don't re-fetch the same icon on every render.
// domain → { buf, type, at }
const cache = new Map();
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// GET /api/favicon?domain=acme.com
// Proxies a domain's favicon through our own origin. The browser only ever
// talks to us (first-party), so privacy/ad blockers and third-party flakiness
// never break the brand logo. Falls through Google → DuckDuckGo, 404 if neither
// has a real icon (the frontend then shows a letter avatar).
router.get("/", async (req, res) => {
  const domain = String(req.query.domain || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/[^a-z0-9.\-]/g, "");

  if (!domain || !domain.includes(".")) return res.status(400).end();

  const sendImg = (buf, type) => {
    res.set("Content-Type", type || "image/png");
    res.set("Cache-Control", "public, max-age=604800"); // 7 days
    res.set("Cross-Origin-Resource-Policy", "cross-origin"); // helmet defaults to same-origin
    return res.send(buf);
  };

  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < TTL_MS) return sendImg(hit.buf, hit.type);

  const sources = [
    `https://www.google.com/s2/favicons?sz=128&domain=${domain}`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];

  for (const url of sources) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue; // Google returns 404 + a default globe for unknown domains
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 120) continue; // skip empty / tiny default icons
      const type = r.headers.get("content-type") || "image/png";
      cache.set(domain, { buf, type, at: Date.now() });
      return sendImg(buf, type);
    } catch {
      /* try next source */
    }
  }

  return res.status(404).end();
});

export default router;
