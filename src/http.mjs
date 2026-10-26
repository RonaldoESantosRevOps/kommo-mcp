// Cliente HTTP da Kommo. O Bearer token só sai para o host da conta e para drive*.kommo.com.
const DRIVE_HOST = /^drive(?:-[a-z0-9]{1,32})?\.kommo\.com$/;
const METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
const CONTROL = /[\u0000-\u001F\u007F]/;
const MAX_RETRIES = 3;
const MAX_DELAY_MS = 8_000;

export class KommoHttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "KommoHttpError";
    this.status = status;
    this.body = body;
  }
}

export function qs(params) {
  const sp = new URLSearchParams();
  const add = (key, val) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (v !== null && typeof v === "object") add(`${key}[${i}]`, v);
        else sp.append(`${key}[]`, String(v));
      });
    } else if (typeof val === "object") {
      for (const [k, v] of Object.entries(val)) add(`${key}[${k}]`, v);
    } else {
      sp.append(key, String(val));
    }
  };
  for (const [k, v] of Object.entries(params || {})) add(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function assertAllowedUrl(raw, apiHost) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new KommoHttpError("URL inválida.");
  }
  if (url.protocol !== "https:") throw new KommoHttpError("Só HTTPS é permitido.");
  if (url.username || url.password) throw new KommoHttpError("URL com usuário ou senha não é permitida.");
  if (url.port) throw new KommoHttpError("Porta explícita não é permitida.");
  if (url.hostname.endsWith(".")) throw new KommoHttpError("Host inválido.");
  const host = url.hostname;
  if (host !== apiHost && !DRIVE_HOST.test(host)) {
    throw new KommoHttpError(
      `Host fora da allowlist do kommo-mcp: ${host}. Permitidos: ${apiHost} e drive*.kommo.com.`
    );
  }
  return url;
}

export function resolveRequestUrl(path, query, { apiHost, base }) {
  if (typeof path !== "string" || !path.trim()) throw new KommoHttpError("path vazio ou inválido.");
  if (path.length > 2000 || CONTROL.test(path) || path.includes("\\") || path.includes("#")) {
    throw new KommoHttpError("path inválido.");
  }
  const trimmed = path.trim();
  let raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (!trimmed.toLowerCase().startsWith("https://")) {
      throw new KommoHttpError("Só URLs https são aceitas. O token não é enviado em claro nem para outros hosts.");
    }
    raw = trimmed;
  } else if (trimmed.startsWith("//")) {
    throw new KommoHttpError("URL protocol-relative não é aceita.");
  } else {
    const rel = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    raw = `${base}${rel}`;
  }
  const extra = qs(query);
  if (extra) raw += raw.includes("?") ? `&${extra.slice(1)}` : extra;
  return assertAllowedUrl(raw, apiHost).href;
}

export function createPacer(minIntervalMs, sleepImpl, now = Date.now) {
  let tail = Promise.resolve();
  let nextStart = 0;
  return function pace() {
    const ticket = tail.then(async () => {
      if (!minIntervalMs) return;
      const wait = nextStart - now();
      if (wait > 0) await sleepImpl(wait);
      nextStart = now() + minIntervalMs;
    });
    tail = ticket.catch(() => {});
    return ticket;
  };
}

function clipBody(data) {
  if (data === null || data === undefined) return data;
  const raw = typeof data === "string" ? data : JSON.stringify(data);
  return raw.length > 1500 ? `${raw.slice(0, 1500)}…` : data;
}

export function createKommoClient({
  token,
  apiHost,
  base,
  minIntervalMs = 200,
  userAgent = "kommo-mcp",
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const pace = createPacer(minIntervalMs, sleepImpl, now);

  async function kommo(method, path, { query, body, headers, timeoutMs = 30_000 } = {}) {
    const verb = String(method || "GET").trim().toUpperCase();
    if (!METHODS.has(verb)) throw new KommoHttpError(`Método não permitido: ${method}`);
    const href = resolveRequestUrl(path, query, { apiHost, base });
    const sendBody = verb === "GET" || verb === "HEAD" ? undefined : body;
    const isRaw = typeof sendBody === "string" || sendBody instanceof Uint8Array;
    const rawBody = sendBody === undefined ? undefined : (isRaw ? sendBody : JSON.stringify(sendBody));
    const reqHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": userAgent,
    };
    if (rawBody !== undefined && !isRaw) reqHeaders["Content-Type"] = "application/json";
    if (headers && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) {
        if (/^(authorization|host|cookie|proxy-authorization)$/i.test(key)) continue;
        reqHeaders[key] = value;
      }
    }

    let res;
    for (let attempt = 0; ; attempt++) {
      await pace();
      try {
        res = await fetchImpl(href, {
          method: verb,
          headers: reqHeaders,
          body: rawBody,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (e instanceof KommoHttpError) throw e;
        if (attempt < MAX_RETRIES && verb === "GET") {
          await sleepImpl(Math.min(400 * 2 ** attempt, MAX_DELAY_MS));
          continue;
        }
        throw new KommoHttpError(`Kommo ${verb} ${path} -> rede/timeout: ${e.message}`);
      }
      const retry = res.status === 429 || (res.status >= 500 && verb === "GET");
      if (retry && attempt < MAX_RETRIES) {
        await res.arrayBuffer().catch(() => {});
        const ra = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(ra) && ra > 0
          ? Math.min(ra * 1000, MAX_DELAY_MS)
          : Math.min(400 * 2 ** attempt, MAX_DELAY_MS);
        await sleepImpl(delay);
        continue;
      }
      break;
    }

    const text = await res.text();
    const clipped = text.length > 100_000 ? text.slice(0, 100_000) : text;
    let data = null;
    if (clipped) {
      try { data = JSON.parse(clipped); } catch { data = clipped; }
    }
    if (!res.ok) {
      const detail = (data && typeof data === "object" && (data.detail || data.title)) || res.statusText;
      throw new KommoHttpError(`Kommo ${verb} ${path} -> HTTP ${res.status}: ${detail}`, {
        status: res.status,
        body: clipBody(data),
      });
    }
    return data;
  }

  return {
    kommo,
    containsSecret(buf) {
      const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      return bytes.includes(Buffer.from(token));
    },
  };
}

export function redactError(err, token) {
  const hide = (value) => {
    let text = String(value ?? "");
    if (token) text = text.split(token).join("[redacted]");
    return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 1500);
  };
  const message = hide(err?.message || err);
  const body = err?.body === undefined ? undefined : hide(typeof err.body === "string" ? err.body : JSON.stringify(err.body));
  return { message, body };
}
