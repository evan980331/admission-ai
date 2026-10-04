/**
 * P3.9 response validation. A 200 alone is never enough: hostname, path scope,
 * filename convention and body markers must all check out.
 * (Manifest-time URL validation lives in P3.8; this checks the LIVE response,
 * including redirect targets.)
 */

export interface ResponseCheck {
  ok: boolean;
  reasons: string[];
  contentType: string | null;
}

const DETAIL_MARKERS = ["校系代碼", "招生名額", "基本資料及時程"];

export function validateResponse(opts: {
  requestCode: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  bodyBytes: number;
  bodyTextSample: string;
}): ResponseCheck {
  const reasons: string[] = [];
  if (opts.status < 200 || opts.status >= 300) reasons.push(`http status ${opts.status}`);
  const ct = opts.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? null;
  if (ct !== null && !ct.includes("text/html")) reasons.push(`content-type ${ct ?? "missing"} is not text/html`);
  let url: URL | null = null;
  try {
    url = new URL(opts.finalUrl);
  } catch {
    reasons.push("final url unparseable");
  }
  if (url) {
    if (url.hostname.toLowerCase() !== "www.cac.edu.tw") reasons.push(`non-CAC host: ${url.hostname}`);
    if (!/(^|\/)mobile_apply115\/|(^|\/)apply115\//.test(url.pathname)) {
      reasons.push(`path outside apply115 scope: ${url.pathname.slice(0, 80)}`);
    }
    const m = url.pathname.match(/(\d{3})_(\d{6})\.htm$/i);
    if (!m) reasons.push("final url is not a 115_<6code>.htm detail page");
    else if (m[2] !== opts.requestCode) reasons.push(`url code ${m[2]} != requested ${opts.requestCode}`);
  }
  if (opts.bodyBytes <= 0) reasons.push("empty body");
  if (opts.bodyBytes > 0) {
    const hits = DETAIL_MARKERS.filter((mk) => opts.bodyTextSample.includes(mk)).length;
    if (hits < 2) reasons.push(`body lacks CAC detail markers (${hits}/3)`);
  }
  return { ok: reasons.length === 0, reasons, contentType: ct };
}
