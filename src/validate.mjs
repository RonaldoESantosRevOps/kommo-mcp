// Validação de argumentos das tools. A descrição JSON do MCP não é imposta pelo SDK.

export const ENTITIES = new Set(["leads", "contacts", "companies"]);
export const LINK_TARGETS = new Set(["leads", "contacts", "companies", "catalog_elements"]);
export const MAX_BATCH = 1000;

const CONTROL = /[\u0000-\u001F\u007F]/;
const DRIVE_HOST = /^drive(?:-[a-z0-9]{1,32})?\.kommo\.com$/;

export function positiveInt(v, key, { allowZero = false } = {}) {
  if (v === undefined || v === null || v === "") {
    throw new Error(`Parâmetro obrigatório ausente: ${key}`);
  }
  if (typeof v === "boolean") throw new Error(`Parâmetro ${key} deve ser inteiro positivo.`);
  let n;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^-?\d+$/.test(v.trim())) n = Number(v.trim());
  else throw new Error(`Parâmetro ${key} deve ser inteiro positivo.`);
  if (!Number.isSafeInteger(n)) throw new Error(`Parâmetro ${key} deve ser inteiro positivo.`);
  if (n === 0 && allowZero) return 0;
  if (n <= 0) throw new Error(`Parâmetro ${key} deve ser inteiro positivo.`);
  return n;
}

export function idList(v, key, { allowZero = false, max = 100 } = {}) {
  if (!Array.isArray(v)) throw new Error(`Parâmetro ${key} deve ser array.`);
  if (v.length > max) throw new Error(`Parâmetro ${key} excede o máximo de ${max} itens.`);
  return v.map((item, i) => positiveInt(item, `${key}[${i}]`, { allowZero }));
}

export function leadIds(v) {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error("lead_ids deve ser uma lista com pelo menos um id.");
  }
  if (v.length > MAX_BATCH) {
    throw new Error(`Lote de ${v.length} leads excede o máximo de ${MAX_BATCH}. Divida a operação.`);
  }
  return [...new Set(v.map((item, i) => positiveInt(item, `lead_ids[${i}]`)))];
}

export function clampLimit(v, fallback, max) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = positiveInt(v, "limit");
  return Math.min(n, max);
}

export function pageNum(v) {
  if (v === undefined || v === null || v === "") return 1;
  const n = positiveInt(v, "page");
  if (n > 10_000) throw new Error("page acima do máximo suportado.");
  return n;
}

export function needString(v, key, { max = 4000, min = 1 } = {}) {
  if (typeof v !== "string") throw new Error(`Parâmetro obrigatório ausente: ${key}`);
  const s = v.trim();
  if (s.length < min) throw new Error(`Parâmetro obrigatório ausente: ${key}`);
  if (s.length > max || CONTROL.test(v)) throw new Error(`Parâmetro ${key} inválido.`);
  return s;
}

export function optionalString(v, key, { max = 4000 } = {}) {
  if (v === undefined || v === null || v === "") return undefined;
  return needString(v, key, { max });
}

export function entityName(v, fallback = "leads") {
  const e = v === undefined || v === null || v === "" ? fallback : v;
  if (!ENTITIES.has(e)) throw new Error("entity inválida. Use leads, contacts ou companies.");
  return e;
}

export function enumValue(v, key, allowed, fallback) {
  const value = v === undefined || v === null || v === "" ? fallback : v;
  if (!allowed.includes(value)) throw new Error(`Parâmetro ${key} inválido.`);
  return value;
}

export function tagNames(v) {
  if (!Array.isArray(v)) throw new Error("tags deve ser uma lista de nomes.");
  if (v.length > 50) throw new Error("No máximo 50 tags por chamada.");
  return v.map((item, i) => needString(item, `tags[${i}]`, { max: 100 }));
}

export function customFields(v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 100) throw new Error("custom_fields_values inválido.");
  for (const item of v) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("custom_fields_values inválido.");
    }
  }
  return v;
}

export function priceValue(v) {
  if (typeof v === "boolean") throw new Error("price inválido.");
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("price inválido.");
  return n;
}

export function scalarBag(obj, key) {
  if (obj === undefined) return undefined;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${key} deve ser um objeto.`);
  const entries = Object.entries(obj);
  if (entries.length > 20) throw new Error(`${key} tem campos demais.`);
  const out = {};
  for (const [k, val] of entries) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) throw new Error(`${key} contém campo inválido.`);
    if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") {
      throw new Error(`${key}.${k} precisa ser texto, número ou booleano.`);
    }
    if (typeof val === "string" && (val.length > 2000 || CONTROL.test(val))) {
      throw new Error(`${key}.${k} inválido.`);
    }
    if (typeof val === "number" && !Number.isFinite(val)) throw new Error(`${key}.${k} inválido.`);
    out[k] = val;
  }
  return out;
}

export function safeUid(v) {
  const s = needString(v, "uid", { max: 128 });
  if (/[\s/?#\\]/.test(s) || s.includes("..")) throw new Error("uid inválido.");
  return s;
}

export function safeLabel(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\p{L}\p{N} .,_:/+-]/gu, "")
    .trim()
    .slice(0, 60);
}

export function webhookDestination(dest, { requireHttps, apiHost, blockApiHost }) {
  if (typeof dest !== "string" || CONTROL.test(dest)) throw new Error("destination inválida.");
  let url;
  try {
    url = new URL(dest.trim());
  } catch {
    throw new Error("destination inválida. Use uma URL absoluta.");
  }
  if (url.username || url.password) throw new Error("destination não pode carregar usuário ou senha.");
  const https = url.protocol === "https:";
  const http = url.protocol === "http:";
  if (requireHttps && !https) throw new Error("Webhook precisa de HTTPS.");
  if (!https && !http) throw new Error("destination inválida.");
  const host = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  if (blockApiHost && (host === apiHost || DRIVE_HOST.test(host))) {
    throw new Error("Webhook não pode apontar para a API da Kommo.");
  }
  return url.href;
}

export function webhookSettings(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 50) {
    throw new Error("settings deve ser uma lista de eventos da Kommo, por exemplo add_lead.");
  }
  return list.map((item) => {
    if (typeof item !== "string" || !/^[a-z0-9_]{1,64}$/.test(item)) {
      throw new Error("evento de webhook inválido. Use o código da Kommo, por exemplo add_lead.");
    }
    return item;
  });
}

export function colorHex(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
    throw new Error("color inválida. Use hex, por exemplo #fffeb2.");
  }
  return v;
}

export function promptInt(v, fallback, min, max) {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string" && typeof v !== "number") throw new Error("argumento numérico inválido");
  if (!/^\d+$/.test(String(v).trim())) throw new Error("argumento numérico inválido");
  const n = Number(v);
  if (n < min || n > max) throw new Error("argumento fora do intervalo");
  return n;
}

export function promptDate(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error("data deve ser YYYY-MM-DD");
  }
  return v;
}

export function assertArgs(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("argumentos inválidos");
  return a;
}
