// Datas, lotes e resumos legíveis. Sem chamada de rede própria.

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function toUnix(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`Data inválida: ${v}`);
    return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  }
  if (typeof v !== "string" || v.length > 40) throw new Error("Data inválida.");
  if (/^\d{10,13}$/.test(v)) {
    const n = Number(v);
    return n > 1e12 ? Math.floor(n / 1000) : n;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Data inválida: ${v}`);
  return Math.floor(t / 1000);
}

export function isoInTz(unix, tz) {
  if (!unix) return null;
  try {
    const s = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(unix * 1000));
    return s.replace(" ", "T");
  } catch {
    return new Date(unix * 1000).toISOString().slice(0, 16) + "Z";
  }
}

export function cfValue(entity, fieldId) {
  const f = entity.custom_fields_values?.find((v) => v.field_id === fieldId);
  if (!f) return undefined;
  return f.values?.map((x) => x.value).join(", ");
}

export function cfByCode(entity, code) {
  const f = entity.custom_fields_values?.find((v) => v.field_code === code);
  return f?.values?.[0]?.value;
}

export function fmtResponsible(userMap, id) {
  const u = userMap.get(id);
  if (!u) return id;
  return u.is_active ? u.name : `${u.name} (inativo)`;
}

function firstLossReason(embedded) {
  const lr = embedded?.loss_reason;
  if (!lr) return undefined;
  return Array.isArray(lr) ? lr[0]?.name : lr.name;
}

export async function summarizeLeads(leads, fields, { kommo, getStatusMap, getUserMap, getAccountInfo, getCustomFields }) {
  const [statusMap, userMap, acc] = await Promise.all([getStatusMap(), getUserMap(), getAccountInfo()]);
  const tz = acc.timezone;
  const contactIds = [...new Set(
    leads.flatMap((l) => (l._embedded?.contacts || []).filter((c) => c.is_main !== false).map((c) => c.id))
  )];
  const contactsById = new Map();
  try {
    for (const part of chunk(contactIds, 50)) {
      const d = await kommo("GET", "/contacts", { query: { filter: { id: part }, limit: 50 } });
      for (const c of d?._embedded?.contacts || []) {
        contactsById.set(c.id, { id: c.id, name: c.name, phone: cfByCode(c, "PHONE") });
      }
    }
  } catch {
    console.error("[kommo-mcp] resumo de contatos indisponível");
  }

  let fieldDefs = null;
  if (fields?.length) {
    const defs = await getCustomFields("leads");
    const missing = [];
    fieldDefs = [];
    for (const f of fields) {
      const def = Number.isInteger(f) || /^\d+$/.test(String(f))
        ? defs.find((d) => d.id === Number(f))
        : defs.find((d) => d.name.toLowerCase() === String(f).toLowerCase());
      if (!def) missing.push(String(f).slice(0, 80));
      else fieldDefs.push(def);
    }
    if (missing.length) {
      throw new Error(`Campos não encontrados: ${missing.join(", ")}. Use kommo_custom_fields.`);
    }
  }

  return leads.map((l) => {
    const st = statusMap.get(`${l.pipeline_id}:${l.status_id}`) || statusMap.get(l.status_id);
    const mainContact = (l._embedded?.contacts || []).find((c) => c.is_main !== false);
    const out = {
      id: l.id,
      name: l.name,
      price: l.price || 0,
      pipeline: st?.pipeline ?? l.pipeline_id,
      status: st?.status ?? l.status_id,
      responsible: fmtResponsible(userMap, l.responsible_user_id),
      created_at: isoInTz(l.created_at, tz),
      updated_at: isoInTz(l.updated_at, tz),
    };
    if (l.closed_at) out.closed_at = isoInTz(l.closed_at, tz);
    const loss = firstLossReason(l._embedded);
    if (loss) out.loss_reason = loss;
    const tags = (l._embedded?.tags || []).map((t) => t.name);
    if (tags.length) out.tags = tags;
    if (mainContact) out.contact = contactsById.get(mainContact.id) || { id: mainContact.id };
    if (fieldDefs) {
      out.custom = {};
      for (const def of fieldDefs) out.custom[def.name] = cfValue(l, def.id) ?? null;
    }
    return out;
  });
}

function fmtStatusChange(statusMap, valueList) {
  const v = valueList?.[0]?.lead_status;
  if (!v) return undefined;
  const st = statusMap.get(`${v.pipeline_id}:${v.id}`) || statusMap.get(v.id);
  return st ? `${st.pipeline} / ${st.status}` : `status#${v.id}`;
}

export async function summarizeEvents(events, { getStatusMap, getUserMap, getAccountInfo }) {
  const [statusMap, userMap, acc] = await Promise.all([getStatusMap(), getUserMap(), getAccountInfo()]);
  const tz = acc.timezone;
  return events.map((e) => {
    const out = {
      type: e.type,
      entity: `${e.entity_type}#${e.entity_id}`,
      at: isoInTz(e.created_at, tz),
      by: e.created_by === 0 ? "bot/sistema" : (userMap.get(e.created_by)?.name || `user#${e.created_by}`),
    };
    const entityName = e._embedded?.entity?.name;
    if (entityName) out.entity_name = entityName;
    switch (e.type) {
      case "lead_status_changed":
        out.from = fmtStatusChange(statusMap, e.value_before);
        out.to = fmtStatusChange(statusMap, e.value_after);
        break;
      case "entity_responsible_changed": {
        const before = e.value_before?.[0]?.responsible_user?.id;
        const after = e.value_after?.[0]?.responsible_user?.id;
        if (before !== undefined) out.from = userMap.get(before)?.name || `user#${before}`;
        if (after !== undefined) out.to = userMap.get(after)?.name || `user#${after}`;
        break;
      }
      case "entity_tag_added":
      case "entity_tag_removed": {
        const tag = e.value_after?.[0]?.tag?.name || e.value_before?.[0]?.tag?.name;
        if (tag) out.tag = tag;
        break;
      }
      case "lead_added":
      case "contact_added":
      case "company_added":
      case "incoming_chat_message":
      case "outgoing_chat_message":
        break;
      default:
        if (e.value_before?.length) out.before = e.value_before;
        if (e.value_after?.length) out.after = e.value_after;
    }
    return out;
  });
}
