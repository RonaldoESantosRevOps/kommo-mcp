import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHandlers } from "../src/handlers.mjs";
import { createKommoClient } from "../src/http.mjs";

const TOKEN = "abcdefghijklmnopqrstuvwxyz";

function setup(overrides = {}) {
  const calls = [];
  const kommo = overrides.kommo || (async (method, path, opts) => {
    calls.push({ method, path, opts });
    return overrides.reply ?? { _embedded: { leads: [] } };
  });
  const statusMap = overrides.statusMap || new Map([
    [20, { status: "Novo", pipeline: "Vendas", pipeline_id: 10, status_id: 20, type: 0 }],
    ["10:20", { status: "Novo", pipeline: "Vendas", pipeline_id: 10, status_id: 20, type: 0 }],
    [142, { status: "Ganho", pipeline: "Vendas", pipeline_id: 10, status_id: 142, type: 0, ambiguous: true }],
    [1, { status: "Entrada", pipeline: "Vendas", pipeline_id: 10, status_id: 1, type: 1 }],
    ["10:1", { status: "Entrada", pipeline: "Vendas", pipeline_id: 10, status_id: 1, type: 1 }],
  ]);
  const invalidated = [];
  const catalog = {
    getStatusMap: async () => statusMap,
    getUserMap: async () => new Map([[5, { name: "Ana", is_active: true }]]),
    getAccountInfo: async () => ({ timezone: "UTC", task_types: [], drive_url: "https://drive-b.kommo.com", id: 1 }),
    getCustomFields: async () => [{ id: 7, name: "Origem", type: "text" }],
    getPipelines: async () => [{ id: 10, name: "Vendas", statuses: [] }],
    getUsers: async () => [],
    getLossReasons: async () => [],
    invalidateCache(prefix) { invalidated.push(prefix); },
    ...overrides.catalog,
  };
  const handle = createHandlers({
    kommo,
    catalog,
    config: {
      readOnly: false,
      apiHost: "demo.kommo.com",
      uploadMaxBytes: 1024 * 1024,
      ...overrides.config,
    },
    containsSecret: overrides.containsSecret || (() => false),
  });
  return { handle, calls, invalidated };
}

test("busca de lead resolve a etapa e limita a página", async () => {
  const { handle, calls } = setup();
  const result = await handle("kommo_search_leads", { status_id: 20, limit: 999, query: "abc" });
  assert.equal(result.page, 1);
  assert.equal(result.has_more, false);
  assert.deepEqual(calls[0].opts.query.filter.statuses, [{ pipeline_id: 10, status_id: 20 }]);
  assert.equal(calls[0].opts.query.limit, 250);
  assert.equal(calls[0].opts.query.query, "abc");
});

test("etapa ambígua, inbox e query curta falham antes de gravar", async () => {
  const { handle, calls } = setup();
  await assert.rejects(() => handle("kommo_search_leads", { status_id: 142 }), /pipeline_id/);
  await assert.rejects(() => handle("kommo_search_leads", { status_id: 1 }), /kommo_unsorted/);
  await assert.rejects(() => handle("kommo_search_leads", { query: "ab" }), /3 ou mais/);
  assert.equal(calls.length, 0);
});

test("atualização usa tags_to_add e descobre o funil da etapa", async () => {
  const { handle, calls } = setup({ reply: { id: 15 } });
  await handle("kommo_update_lead", { lead_id: "15", status_id: 20, tags_to_add: ["vip"], tags_to_remove: ["frio"] });
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].path, "/leads/15");
  assert.equal(calls[0].opts.body.pipeline_id, 10);
  assert.deepEqual(calls[0].opts.body.tags_to_add, [{ name: "vip" }]);
  assert.deepEqual(calls[0].opts.body.tags_to_delete, [{ name: "frio" }]);
  assert.equal(calls[0].opts.body._embedded, undefined);
});

test("lote vazio ou grande nem chega na API", async () => {
  const { handle, calls } = setup();
  await assert.rejects(() => handle("kommo_change_responsible", { lead_ids: [], responsible_user_id: 5 }));
  await assert.rejects(() => handle("kommo_bulk_update_leads", {
    lead_ids: Array.from({ length: 1001 }, (_v, i) => i + 1),
    price: 10,
  }), /1000/);
  assert.equal(calls.length, 0);
});

test("entity do caminho é uma lista fechada", async () => {
  const { handle, calls } = setup();
  await assert.rejects(() => handle("kommo_add_note", { entity: "../users", entity_id: 1, text: "oi" }));
  await assert.rejects(() => handle("kommo_get_lead", {}));
  await assert.rejects(() => handle("kommo_create_lead", { name: "Exemplo", price: -1 }));
  assert.equal(calls.length, 0);
});

test("modo somente leitura bloqueia escrita e libera GET", async () => {
  const { handle, calls } = setup({ config: { readOnly: true }, reply: { id: 1 } });
  await assert.rejects(() => handle("kommo_update_lead", { lead_id: 1, name: "X" }), /KOMMO_READ_ONLY/);
  await assert.rejects(() => handle("kommo_request", { method: "POST", path: "/leads", body: [{}] }), /GET/);
  const account = await handle("kommo_request", { path: "/account" });
  assert.deepEqual(account, { id: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
});

test("webhook https não pode apontar para a própria API", async () => {
  const { handle, calls } = setup();
  await assert.rejects(() => handle("kommo_subscribe_webhook", {
    destination: "http://example.com/hook",
    settings: ["add_lead"],
  }), /HTTPS/);
  await assert.rejects(() => handle("kommo_subscribe_webhook", {
    destination: "https://demo.kommo.com/hook",
    settings: ["add_lead"],
  }), /API da Kommo/);
  await handle("kommo_subscribe_webhook", {
    destination: "https://example.com/hook",
    settings: ["add_lead"],
  });
  assert.equal(calls[0].opts.body.destination, "https://example.com/hook");
  await assert.rejects(() => handle("kommo_subscribe_webhook", {
    destination: "https://example.com/hook",
    settings: ["add lead"],
  }));
});

test("upload recusa .env e arquivo que contém o token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kommo-upload-"));
  const envFile = join(dir, ".env");
  const note = join(dir, "nota.txt");
  writeFileSync(envFile, "KOMMO_TOKEN=x");
  writeFileSync(note, `relato ${TOKEN}`);
  const client = createKommoClient({
    token: TOKEN,
    apiHost: "demo.kommo.com",
    base: "https://demo.kommo.com/api/v4",
    minIntervalMs: 0,
    fetchImpl: async () => { throw new Error("sem rede"); },
  });
  const { handle, calls } = setup({ containsSecret: client.containsSecret });
  await assert.rejects(() => handle("kommo_upload_file", { file_path: envFile }), /segredo/);
  await assert.rejects(() => handle("kommo_upload_file", { file_path: note }), /segredo/);
  assert.equal(calls.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("passthrough do handler passa pela allowlist do cliente", async () => {
  let called = 0;
  const client = createKommoClient({
    token: TOKEN,
    apiHost: "demo.kommo.com",
    base: "https://demo.kommo.com/api/v4",
    minIntervalMs: 0,
    fetchImpl: async () => { called++; return { status: 200, ok: true, statusText: "OK", headers: { get: () => null }, text: async () => "{}", arrayBuffer: async () => new ArrayBuffer(0) }; },
  });
  const { handle } = setup({ kommo: client.kommo });
  await assert.rejects(() => handle("kommo_request", { path: "https://example.com/steal-token" }), /allowlist/);
  assert.equal(called, 0);
  await handle("kommo_request", { path: "/catalogs" });
  assert.equal(called, 1);
});

test("lead com telefone usa o endpoint complexo e preserva tags", async () => {
  const { handle, calls } = setup({ reply: [{ id: 9 }] });
  await handle("kommo_create_lead", { name: "Contato exemplo", contact_phone: "+5500000000000", tags: ["novo"] });
  assert.equal(calls[0].path, "/leads/complex");
  assert.equal(calls[0].opts.body[0]._embedded.contacts[0].first_name, "Contato exemplo");
  assert.deepEqual(calls[0].opts.body[0]._embedded.tags, [{ name: "novo" }]);
});

test("contato pode nascer só com telefone e a etapa nova invalida o cache", async () => {
  const { handle, calls, invalidated } = setup({ reply: { _embedded: { contacts: [{ id: 3 }] } } });
  await handle("kommo_create_contact", { phone: "+5500000000000" });
  assert.equal(calls[0].opts.body[0].custom_fields_values[0].field_code, "PHONE");
  await handle("kommo_create_status", { pipeline_id: 10, name: "Proposta", sort: 0, color: "#fffeb2" });
  assert.deepEqual(invalidated, ["pipelines"]);
});

test("salesbot usa o host configurado, não um host recebido na tool", async () => {
  const { handle, calls } = setup({ reply: { ok: true } });
  await handle("kommo_run_salesbot", { bot_id: 4, entity_id: 8 });
  assert.equal(calls[0].path, "https://demo.kommo.com/api/v2/salesbot/run");
  assert.equal(calls[0].opts.body[0].entity_type, 2);
});
