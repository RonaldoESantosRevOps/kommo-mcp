// Carrega e valida a configuração. Não registra o token em log.
import { readFileSync } from "node:fs";

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PLACEHOLDER_TOKENS = new Set([
  "seu_token_de_longa_duracao",
  "cole-o-token-aqui",
  "cole-o-token-de-longa-duracao",
  "changeme",
]);

export function loadEnv(file, target = process.env) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const body = t.startsWith("export ") ? t.slice(7).trim() : t;
    const i = body.indexOf("=");
    if (i === -1) continue;
    const k = body.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    let v = body.slice(i + 1).trim();
    const quoted = (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"));
    if (quoted) v = v.slice(1, -1);
    else {
      const hash = v.search(/\s+#/);
      if (hash !== -1) v = v.slice(0, hash).trim();
    }
    if (!(k in target)) target[k] = v;
  }
  return true;
}

function flag(raw, name) {
  if (raw === undefined || raw === "") return false;
  const s = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  throw new Error(`${name} inválido. Use 1 ou 0.`);
}

function boundedInt(raw, { name, fallback, min, max }) {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw).trim())) throw new Error(`${name} inválido.`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} fora do intervalo ${min}–${max}.`);
  return n;
}

export function normalizeSubdomain(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Faltam KOMMO_SUBDOMAIN e/ou KOMMO_TOKEN (defina no .env ou no ambiente).");
  }
  const s = raw.trim().toLowerCase().replace(/\.kommo\.com$/i, "");
  if (!SUBDOMAIN.test(s)) {
    throw new Error(
      "KOMMO_SUBDOMAIN inválido. Informe só o rótulo da conta (exemplo: minhaempresa), sem https:// e sem caminho."
    );
  }
  return s;
}

export function normalizeToken(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Faltam KOMMO_SUBDOMAIN e/ou KOMMO_TOKEN (defina no .env ou no ambiente).");
  }
  let t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  if (PLACEHOLDER_TOKENS.has(t)) {
    throw new Error("KOMMO_TOKEN ainda está com o valor de exemplo. Gere um token na Kommo e cole no .env.");
  }
  if (t.length < 20 || t.length > 8192 || /[\s\u0000-\u001F\u007F]/.test(t)) {
    throw new Error("KOMMO_TOKEN inválido. Cole o token de longa duração em uma única linha, sem espaços.");
  }
  return t;
}

export function readConfig(env) {
  if (!env.KOMMO_SUBDOMAIN || !env.KOMMO_TOKEN) {
    throw new Error("Faltam KOMMO_SUBDOMAIN e/ou KOMMO_TOKEN (defina no .env ou no ambiente).");
  }
  const subdomain = normalizeSubdomain(env.KOMMO_SUBDOMAIN);
  const token = normalizeToken(env.KOMMO_TOKEN);
  return {
    subdomain,
    token,
    apiHost: `${subdomain}.kommo.com`,
    base: `https://${subdomain}.kommo.com/api/v4`,
    readOnly: flag(env.KOMMO_READ_ONLY, "KOMMO_READ_ONLY"),
    redactEmails: flag(env.KOMMO_REDACT_USER_EMAILS, "KOMMO_REDACT_USER_EMAILS"),
    minIntervalMs: boundedInt(env.KOMMO_MIN_INTERVAL_MS, {
      name: "KOMMO_MIN_INTERVAL_MS",
      fallback: 200,
      min: 0,
      max: 10_000,
    }),
    uploadMaxBytes: boundedInt(env.KOMMO_UPLOAD_MAX_BYTES, {
      name: "KOMMO_UPLOAD_MAX_BYTES",
      fallback: 20 * 1024 * 1024,
      min: 1,
      max: 100 * 1024 * 1024,
    }),
  };
}

export function publicConfig(config) {
  return {
    subdomain: config.subdomain,
    apiHost: config.apiHost,
    base: config.base,
    readOnly: config.readOnly,
    redactEmails: config.redactEmails,
    minIntervalMs: config.minIntervalMs,
    uploadMaxBytes: config.uploadMaxBytes,
  };
}
