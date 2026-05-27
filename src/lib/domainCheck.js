// Domain reachability check — runs before accepting a new brand so the audit
// pipeline never tracks a non-existent site (otherwise AI engines hallucinate
// answers about brand names that share the project name, producing garbage
// scores like the ziva.in case where Ubersuggest correctly rejected the
// unreachable domain).

const FETCH_TIMEOUT_MS = 8000;

async function tryReach(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // HEAD first (cheap); some servers reject HEAD so fall back to GET.
    let res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "AIVet-DomainCheck/1.0" },
    }).catch(() => null);
    if (!res || res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "AIVet-DomainCheck/1.0" },
      });
    }
    return res?.status ?? 0;
  } catch (err) {
    return { error: err.code || err.name || err.message || "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check whether a bare domain (e.g. "nike.com") is reachable over HTTP(S).
 * Returns { ok: true } if any response status comes back, otherwise
 * { ok: false, reason }. Treats DNS failures, connection refused and
 * timeouts as unreachable; treats 2xx/3xx/4xx as reachable (server exists);
 * treats 5xx as reachable too (server is alive, just erroring).
 */
export async function verifyDomainReachable(domain) {
  const clean = String(domain || "").trim().toLowerCase();
  if (!clean) return { ok: false, reason: "empty" };

  // Try HTTPS first, then HTTP — many small sites only serve one.
  const httpsResult = await tryReach(`https://${clean}`);
  if (typeof httpsResult === "number" && httpsResult > 0) {
    return { ok: true, status: httpsResult, scheme: "https" };
  }
  const httpResult = await tryReach(`http://${clean}`);
  if (typeof httpResult === "number" && httpResult > 0) {
    return { ok: true, status: httpResult, scheme: "http" };
  }

  const httpsErr = typeof httpsResult === "object" ? httpsResult.error : "no_response";
  const httpErr = typeof httpResult === "object" ? httpResult.error : "no_response";
  // Surface the more informative error (DNS errors are typically ENOTFOUND).
  const reason = /ENOTFOUND|getaddrinfo/i.test(httpsErr + " " + httpErr)
    ? "dns_not_found"
    : /AbortError/i.test(httpsErr + " " + httpErr)
    ? "timeout"
    : "unreachable";
  return { ok: false, reason };
}
