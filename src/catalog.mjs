// Cache da estrutura da conta: funis, usuários, campos, motivos de perda.
const TTL = 5 * 60_000;
const ACCOUNT_TTL = 30 * 60_000;
const MAX_PAGES = 20;

async function listAll(kommo, path, key, query = {}) {
  const items = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const d = await kommo("GET", path, { query: { ...query, limit: 250, page } });
    const batch = d?._embedded?.[key] || [];
    let added = 0;
    for (const item of batch) {
      const id = item?.id;
      if (id !== undefined && seen.has(id)) continue;
      if (id !== undefined) seen.add(id);
      items.push(item);
      added++;
    }
    if (!batch.length || !d?._links?.next || added === 0) break;
  }
  return items;
}

export function createCatalog(kommo, { redactEmails = false } = {}) {
  const cache = new Map();

  async function cached(key, ttlMs, fn) {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;
    const value = await fn();
    cache.set(key, { value, exp: Date.now() + ttlMs });
    return value;
  }

  function invalidateCache(prefix = "") {
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
  }

  async function getPipelines() {
    return cached("pipelines", TTL, async () => {
      const d = await kommo("GET", "/leads/pipelines");
      const rows = d?._embedded?.pipelines || [];
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        is_main: p.is_main,
        statuses: (p._embedded?.statuses || []).map((s) => ({
          id: s.id,
          name: s.name,
          sort: s.sort,
          type: s.type,
        })),
      }));
    });
  }

  async function getStatusMap() {
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

  async function getUsers() {
    return cached("users", TTL, async () => {
      const rows = await listAll(kommo, "/users", "users");
      return rows.map((u) => {
        const user = {
          id: u.id,
          name: u.name,
          is_active: u.rights?.is_active ?? true,
          is_admin: u.rights?.is_admin ?? false,
        };
        if (!redactEmails) user.email = u.email;
        return user;
      });
    });
  }

  async function getUserMap() {
    const users = await getUsers();
    return new Map(users.map((u) => [u.id, u]));
  }

  async function getCustomFields(entity = "leads") {
    if (!["leads", "contacts", "companies"].includes(entity)) throw new Error("entity inválida.");
    return cached(`cf:${entity}`, TTL, async () => {
      const rows = await listAll(kommo, `/${entity}/custom_fields`, "custom_fields");
      return rows.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        code: f.code,
        enums: f.enums?.map((e) => ({ id: e.id, value: e.value })),
      }));
    });
  }

  async function getAccountInfo() {
    return cached("account", ACCOUNT_TTL, async () => {
      const d = await kommo("GET", "/account", { query: { with: "task_types,datetime_settings,drive_url" } });
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

  async function getLossReasons() {
    return cached("loss_reasons", TTL, async () => {
      const d = await kommo("GET", "/leads/loss_reasons");
      return (d?._embedded?.loss_reasons || []).map((r) => ({ id: r.id, name: r.name }));
    });
  }

  return {
    invalidateCache,
    getPipelines,
    getStatusMap,
    getUsers,
    getUserMap,
    getCustomFields,
    getAccountInfo,
    getLossReasons,
  };
}
