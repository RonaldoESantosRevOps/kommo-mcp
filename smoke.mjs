// Smoke test end-to-end: sobe o server via stdio e chama tools read-only contra a API real.
// Escrita opcional (round-trip de webhook, inofensivo): node smoke.mjs --write
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({
  command: "node",
  args: ["index.mjs"],
  cwd: __dirname,
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "2.0.0" }, { capabilities: {} });
await client.connect(transport);

function parse(res) {
  const t = res.content?.[0]?.text ?? "";
  try { return JSON.parse(t); } catch { return t; }
}
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`tool ${name} retornou erro: ${parse(res)}`);
  return parse(res);
}
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}
function assertList(shape, label) {
  assert(Array.isArray(shape.items), `${label}: items deve ser array`);
  assert(typeof shape.page === "number", `${label}: page deve ser número`);
  assert(typeof shape.has_more === "boolean", `${label}: has_more deve ser boolean`);
}

// ---- protocolo: tools, prompts, resources ----
const { tools } = await client.listTools();
console.log(`\n✓ tools expostas: ${tools.length}`);
assert(tools.length === 41, `esperava 41 tools, veio ${tools.length}`);
const ro = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
assert(ro.includes("kommo_search_leads") && ro.includes("kommo_talks"), "annotations readOnlyHint ausentes");
assert(!ro.includes("kommo_update_lead"), "kommo_update_lead não pode ser readOnly");
console.log(`✓ annotations ok (${ro.length} tools read-only)`);
const taskTool = tools.find((t) => t.name === "kommo_create_task");
const ttDesc = taskTool.inputSchema.properties.task_type_id.description || "";
console.log(`✓ task_type_id dinâmico: "${ttDesc.slice(0, 90)}..."`);

const { prompts } = await client.listPrompts();
assert(prompts.length === 4, `esperava 4 prompts, veio ${prompts.length}`);
const gp = await client.getPrompt({ name: "fila-agora", arguments: {} });
assert(gp.messages?.[0]?.content?.text?.includes("kommo_talks"), "prompt fila-agora sem conteúdo esperado");
console.log(`✓ prompts: ${prompts.map((p) => p.name).join(", ")}`);

const { resources } = await client.listResources();
assert(resources.length === 8, `esperava 8 resources, veio ${resources.length}`);
const rr = await client.readResource({ uri: "kommo://task-types" });
const taskTypes = JSON.parse(rr.contents[0].text);
console.log(`✓ resources: ${resources.length}; kommo://task-types -> ${taskTypes.map((t) => t.name).join(", ")}`);

// ---- segurança: allowlist do passthrough ----
const evil = await client.callTool({
  name: "kommo_request",
  arguments: { path: "https://example.com/steal-token" },
});
assert(evil.isError, "allowlist NÃO bloqueou host externo!");
assert(String(parse(evil)).includes("allowlist"), "erro do allowlist sem mensagem clara");
console.log("✓ allowlist bloqueia host externo no passthrough");

// ---- leituras básicas ----
const acc = await call("kommo_account");
console.log(`✓ kommo_account -> ${acc.name} (id ${acc.id}, ${acc.currency})`);

const pipes = await call("kommo_pipelines");
console.log(`✓ kommo_pipelines -> ${pipes.length} funis; principal: ${pipes.find((p) => p.is_main)?.name}`);

const users = await call("kommo_users");
assert(users.every((u) => typeof u.is_active === "boolean"), "users sem is_active");
const inativos = users.filter((u) => !u.is_active).map((u) => u.name);
console.log(`✓ kommo_users -> ${users.length} usuários (${inativos.length} inativos: ${inativos.join(", ") || "nenhum"})`);

// ---- leads: resumo, has_more, filtro por etapa sem funil (B1) ----
const leads = await call("kommo_search_leads", { limit: 3 });
assertList(leads, "search_leads");
if (leads.items.length) {
  const l = leads.items[0];
  assert(typeof l.pipeline === "string" && typeof l.status === "string", "lead resumido sem nomes de funil/etapa");
  assert(typeof l.created_at === "string" && l.created_at.includes("T"), "lead resumido sem data ISO");
  console.log(`✓ kommo_search_leads -> resumo ok; ex.: #${l.id} "${l.name}" [${l.pipeline} / ${l.status}] resp: ${l.responsible}${l.contact?.phone ? " tel: " + l.contact.phone : ""}`);
}
const rawLeads = await call("kommo_search_leads", { limit: 1, raw: true });
assert(rawLeads.items[0]?.custom_fields_values !== undefined || rawLeads.items.length === 0, "raw=true deveria trazer o lead cru");
console.log("✓ kommo_search_leads raw=true -> payload cru preservado");

// Etapa "normal": pula a de entrada (type=1, vive no unsorted) e as universais 142/143.
const isNormal = (s) => s.type !== 1 && s.id !== 142 && s.id !== 143;
const somePipe = pipes.find((p) => p.statuses.some(isNormal)) || pipes[0];
const someStatus = somePipe.statuses.find(isNormal);
const byStatus = await call("kommo_search_leads", { status_id: someStatus.id, limit: 2 });
assertList(byStatus, "search_leads por status");
assert(
  byStatus.items.every((l) => l.status === someStatus.name),
  `filtro por etapa sem funil vazou: esperava só "${someStatus.name}"`
);
console.log(`✓ B1: status_id sem pipeline_id resolve o funil sozinho (${somePipe.name} / ${someStatus.name}, ${byStatus.items.length} leads)`);

const inboxStatus = pipes.flatMap((p) => p.statuses).find((s) => s.type === 1);
if (inboxStatus) {
  const blocked = await client.callTool({ name: "kommo_search_leads", arguments: { status_id: inboxStatus.id, limit: 1 } });
  assert(blocked.isError && String(parse(blocked)).includes("kommo_unsorted"), "etapa de entrada deveria apontar para kommo_unsorted");
  console.log("✓ etapa de entrada bloqueada na busca com dica do kommo_unsorted");
}
const ambiguous = await client.callTool({ name: "kommo_search_leads", arguments: { status_id: 142, limit: 1 } });
assert(ambiguous.isError && String(parse(ambiguous)).includes("pipeline_id"), "status 142 sem funil deveria exigir pipeline_id");
console.log("✓ status universal (142) sem funil exige pipeline_id com erro claro");

// ---- eventos traduzidos ----
const ev = await call("kommo_get_events", { created_by: [0], limit: 5 });
assertList(ev, "get_events");
for (const e of ev.items.slice(0, 3)) {
  console.log(`    • ${e.at}  ${e.type}  ${e.entity}  by=${e.by}${e.from ? `  ${e.from} -> ${e.to}` : ""}`);
}
assert(ev.items.every((e) => e.by === "bot/sistema"), "eventos created_by=0 deveriam vir como bot/sistema");
assert(ev.items.every((e) => typeof e.at === "string"), "eventos sem data ISO");
const mv = ev.items.find((e) => e.type === "lead_status_changed");
if (mv) assert(typeof mv.to === "string" && mv.to.includes("/"), "lead_status_changed sem tradução Funil / Etapa");
console.log(`✓ kommo_get_events -> ${ev.items.length} eventos traduzidos (autor, etapas por nome, ISO)`);

// ---- tarefas, contatos, empresas ----
const tasks = await call("kommo_list_tasks", { limit: 3 });
assertList(tasks, "list_tasks");
console.log(`✓ kommo_list_tasks -> ${tasks.items.length} tarefas resumidas`);

const contacts = await call("kommo_search_contacts", { limit: 3 });
assertList(contacts, "search_contacts");
console.log(`✓ kommo_search_contacts -> ${contacts.items.length}; ex.: ${contacts.items[0]?.name} tel=${contacts.items[0]?.phone || "?"}`);

const companies = await call("kommo_search_companies", { limit: 3 });
assertList(companies, "search_companies");
console.log(`✓ kommo_search_companies -> ${companies.items.length} empresas`);

// ---- novas superfícies: tags, perdas, talks, inbox, catálogo ----
const tags = await call("kommo_tags", { limit: 10 });
assertList(tags, "tags");
console.log(`✓ kommo_tags -> ${tags.items.length} tags (has_more=${tags.has_more}); ex.: ${tags.items.slice(0, 4).map((t) => t.name).join(", ")}`);

const losses = await call("kommo_loss_reasons");
console.log(`✓ kommo_loss_reasons -> ${losses.length} motivos: ${losses.slice(0, 4).map((r) => r.name).join(", ")}...`);

const talks = await call("kommo_talks", { limit: 3 });
assertList(talks, "talks");
console.log(`✓ kommo_talks -> ${talks.items.length} conversas${talks.total !== undefined ? ` (total ${talks.total})` : ""}${talks.items[0] ? `; ex.: talk ${talks.items[0].talk_id} ${talks.items[0].status} lead ${talks.items[0].lead_id}` : ""}`);

const inbox = await call("kommo_unsorted", { limit: 3 });
assertList(inbox, "unsorted");
console.log(`✓ kommo_unsorted -> ${inbox.items.length} na fila (has_more=${inbox.has_more})${inbox.items[0] ? `; mais antigo visível: ${inbox.items[0].created_at} de "${inbox.items[0].from}"` : ""}`);
const inboxSummary = await call("kommo_unsorted", { summary: true });
console.log(`✓ kommo_unsorted summary -> ${JSON.stringify(inboxSummary).slice(0, 120)}`);

const cats = await call("kommo_request", { path: "/catalogs" });
const firstCat = cats?._embedded?.catalogs?.[0];
if (firstCat) {
  const els = await call("kommo_catalog_elements", { catalog_id: firstCat.id, limit: 5 });
  assertList(els, "catalog_elements");
  console.log(`✓ kommo_catalog_elements("${firstCat.name}") -> ${els.items.length} elementos`);
} else {
  console.log("• sem catálogos na conta; kommo_catalog_elements não exercitada");
}

// ---- validação de input ----
const bad = await client.callTool({ name: "kommo_get_lead", arguments: {} });
assert(bad.isError && String(parse(bad)).includes("lead_id"), "validação de lead_id ausente");
console.log("✓ validação de input: erro claro antes de bater na API");

// ---- teste de ESCRITA opcional (round-trip de webhook, sem tocar leads) ----
if (process.argv.includes("--write")) {
  const testUrl = "https://example.com/kommo-mcp-write-test";
  console.log("\n— teste de escrita (webhook round-trip) —");
  await call("kommo_subscribe_webhook", { destination: testUrl, settings: ["add_lead"] });
  const after = await call("kommo_list_webhooks");
  const exists = after.some((h) => h.destination === testUrl);
  console.log(`✓ subscribe -> webhook de teste presente na lista: ${exists}`);
  await call("kommo_delete_webhook", { destination: testUrl });
  const final = await call("kommo_list_webhooks");
  const gone = !final.some((h) => h.destination === testUrl);
  console.log(`✓ delete   -> webhook de teste removido: ${gone}`);
  if (!exists || !gone) throw new Error("round-trip de webhook falhou");
}

await client.close();
console.log("\n✓ SMOKE OK — server MCP v2 responde via protocolo e fala com a Kommo real.");
