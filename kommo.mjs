// Cliente HTTP da Kommo + carregador de .env. Sem dependências externas (Node 24 tem fetch global).
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

// Serializa params aninhados no padrão filter[x][]=... que a Kommo usa.
function qs(params) {
  const sp = new URLSearchParams();
  const add = (key, val) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) {
      for (const v of val) sp.append(`${key}[]`, String(v));
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

// Chamada principal. path relativo (ex: "/leads") ou começando com "?" para query crua.
export async function kommo(method, path, { query, body } = {}) {
  let url;
  if (/^https?:\/\//.test(path)) url = path;
  else url = BASE + (path.startsWith("/") ? path : `/${path}`);
  if (query && typeof query === "object") url += qs(query);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

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

// Helpers de domínio reaproveitados pelas tools ----------------------------

export async function getPipelines() {
  const d = await kommo("GET", "/leads/pipelines");
  return (d?._embedded?.pipelines || []).map((p) => ({
    id: p.id,
    name: p.name,
    is_main: p.is_main,
    statuses: (p._embedded?.statuses || []).map((s) => ({ id: s.id, name: s.name, sort: s.sort })),
  }));
}

export async function getUsers() {
  const d = await kommo("GET", "/users", { query: { limit: 250 } });
  return (d?._embedded?.users || []).map((u) => ({ id: u.id, name: u.name, email: u.email }));
}

// Converte data ISO/epoch em segundos unix.
export function toUnix(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : v;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Data inválida: ${v}`);
  return Math.floor(t / 1000);
}
