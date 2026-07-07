// Cliente HTTP da Kommo + carregador de .env + cache leve. Sem dependências externas (Node 24 tem fetch global).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Carrega .env ao lado deste arquivo (sem dep dotenv).
function loadEnv() {
  try {
    const raw = readFileSync(join(__dirname, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    // .env ausente: confia no ambiente
  }
}
loadEnv();

const SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const TOKEN = process.env.KOMMO_TOKEN;
if (!SUBDOMAIN || !TOKEN) {
  throw new Error("Faltam KOMMO_SUBDOMAIN e/ou KOMMO_TOKEN (defina no .env ou no ambiente).");
}
const BASE = `https://${SUBDOMAIN}.kommo.com/api/v4`;
const API_HOST = `${SUBDOMAIN}.kommo.com`;

// Allowlist de hosts que podem receber o Bearer token. Sem isso, uma URL absoluta
// arbitrária no passthrough exfiltraria o token de admin para qualquer servidor.
function assertAllowedHost(url) {
  const host = new URL(url).host;
  const ok = host === API_HOST || /^drive(-[a-z0-9]+)?\.kommo\.com$/.test(host);
  if (!ok) {
    throw new Error(
      `Host fora da allowlist do kommo-mcp: ${host}. Permitidos: ${API_HOST} e drive*.kommo.com.`
    );
  }
}

// Serializa params aninhados no padrão filter[x][]=... que a Kommo usa.
function qs(params) {
  const sp = new URLSearchParams();
  const add = (key, val) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) {
      val.forEach((v, i) => {
        // Arrays de objetos (ex.: filter[statuses][0][pipeline_id]) precisam de índice explícito.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Métodos seguros de repetir em 5xx/falha de rede. POST só re-tenta em 429
// (a requisição foi recusada antes de processar), nunca em 5xx (poderia duplicar).
const IDEMPOTENT = new Set(["GET", "PATCH", "DELETE", "PUT"]);
const MAX_RETRIES = 3;

// Chamada principal. path relativo (ex: "/leads") ou URL absoluta (validada pela allowlist).
export async function kommo(method, path, { query, body, headers, timeoutMs = 30_000 } = {}) {
  let url;
  if (/^https?:\/\//.test(path)) url = path;
  else url = BASE + (path.startsWith("/") ? path : `/${path}`);
  if (query && typeof query === "object") url += qs(query);
  assertAllowedHost(url);

  const rawBody = body === undefined
    ? undefined
    : (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body));

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: rawBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (attempt < MAX_RETRIES && IDEMPOTENT.has(method)) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      const err = new Error(`Kommo ${method} ${path} -> rede/timeout: ${e.message}`);
      err.cause = e;
      throw err;
    }
    const retriable = res.status === 429 || (res.status >= 500 && IDEMPOTENT.has(method));
    if (retriable && attempt < MAX_RETRIES) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 400 * 2 ** attempt);
      continue;
    }
    break;
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const detail = (data && (data.detail || data.title)) || res.statusText;
    const err = new Error(`Kommo ${method} ${path} -> HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export const config = { SUBDOMAIN, BASE };

// Cache em memória com TTL (o processo vive a sessão inteira do cliente MCP) ------

const _cache = new Map();
export async function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const value = await fn();
  _cache.set(key, { value, exp: Date.now() + ttlMs });
  return value;
}
export function invalidateCache(prefix = "") {
  for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k);
}

const TTL = 5 * 60_000; // dados de estrutura mudam raramente

// Helpers de domínio reaproveitados pelas tools ----------------------------

export async function getPipelines() {
  return cached("pipelines", TTL, async () => {
    const d = await kommo("GET", "/leads/pipelines");
    return (d?._embedded?.pipelines || []).map((p) => ({
      id: p.id,
      name: p.name,
      is_main: p.is_main,
      // type 1 = etapa de entrada (Inbox): leads dela vivem em /leads/unsorted, não em /leads.
      statuses: (p._embedded?.statuses || []).map((s) => ({ id: s.id, name: s.name, sort: s.sort, type: s.type })),
    }));
  });
}

// Map status_id -> { status, pipeline, pipeline_id, type, ambiguous } (status 142/143 se
// repetem por funil, então a chave composta "pipeline:status" também entra no mapa e a
// entrada simples ganha ambiguous=true quando o id existe em 2+ funis).
export async function getStatusMap() {
  const pipes = await getPipelines();
  const map = new Map();
  for (const p of pipes) {
    for (const s of p.statuses) {
      const entry = { status: s.name, pipeline: p.name, pipeline_id: p.id, status_id: s.id, type: s.type };
      if (map.has(s.id)) map.get(s.id).ambiguous = true;
      else map.set(s.id, entry);
      map.set(`${p.id}:${s.id}`, entry);
    }
  }
  return map;
}

export async function getUsers() {
  return cached("users", TTL, async () => {
    const d = await kommo("GET", "/users", { query: { limit: 250 } });
    return (d?._embedded?.users || []).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      is_active: u.rights?.is_active ?? true,
      is_admin: u.rights?.is_admin ?? false,
    }));
  });
}

export async function getUserMap() {
  const users = await getUsers();
  return new Map(users.map((u) => [u.id, u]));
}

export async function getCustomFields(entity = "leads") {
  return cached(`cf:${entity}`, TTL, async () => {
    const d = await kommo("GET", `/${entity}/custom_fields`, { query: { limit: 250 } });
    return (d?._embedded?.custom_fields || []).map((f) => ({
      id: f.id, name: f.name, type: f.type, code: f.code,
      enums: f.enums?.map((e) => ({ id: e.id, value: e.value })),
    }));
  });
}

// Dados da conta usados pelos resumos (fuso) e pelas descrições dinâmicas (task_types).
export async function getAccountInfo() {
  return cached("account", 30 * 60_000, async () => {
    const d = await kommo("GET", "/account", {
      query: { with: "task_types,datetime_settings,drive_url" },
    });
    return {
      id: d.id,
      name: d.name,
      subdomain: d.subdomain,
      currency: d.currency,
      timezone: d._embedded?.datetime_settings?.timezone || "UTC",
      drive_url: d.drive_url || null,
      task_types: (d._embedded?.task_types || [])
        .filter((t) => t.is_active)
        .map((t) => ({ id: t.id, name: t.name })),
    };
  });
}

// Converte data ISO/epoch em segundos unix.
export function toUnix(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : v;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Data inválida: ${v}`);
  return Math.floor(t / 1000);
}

// Epoch -> "2026-07-07T15:04" no fuso indicado (fuso da conta nos resumos).
export function isoInTz(unix, tz) {
  if (!unix) return null;
  try {
    const s = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz || "UTC",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).format(new Date(unix * 1000));
    return s.replace(" ", "T");
  } catch {
    return new Date(unix * 1000).toISOString().slice(0, 16) + "Z";
  }
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
