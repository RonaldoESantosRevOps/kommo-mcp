// Smoke test opcional contra a API real. A saída evita nome, telefone e token.
// Escrita: node tests/smoke.mjs --write  (cria e remove um webhook de teste)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadEnv, readConfig } from "../src/config.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = { ...process.env };
loadEnv(join(root, ".env"), env);
try {
  readConfig(env);
} catch (err) {
  console.error(`[kommo-mcp] ${err.message}`);
  console.error("O smoke test precisa de um .env com a sua conta. Sem conta, use npm test.");
  process.exit(1);
}

function configuredToken() {
  if (process.env.KOMMO_TOKEN) return process.env.KOMMO_TOKEN.trim();
  try {
    const raw = readFileSync(join(root, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("KOMMO_TOKEN=")) continue;
      let value = t.slice("KOMMO_TOKEN=".length).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    return "";
  }
  return "";
}

const secret = configuredToken();
function assertNoSecret(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (secret && secret.length > 8 && text.includes(secret)) {
    throw new Error("a resposta contém o token; o teste foi interrompido");
  }
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["index.mjs"],
  cwd: root,
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "2.1.0" }, { capabilities: {} });
await client.connect(transport);

function parse(res) {
  const text = res.content?.[0]?.text ?? "";
  assertNoSecret(text);
  try { return JSON.parse(text); } catch { return text; }
}
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`tool ${name} retornou erro`);
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

const { tools } = await client.listTools();
console.log(`\n✓ tools expostas: ${tools.length}`);
assert(tools.length === 41, `esperava 41 tools, veio ${tools.length}`);
const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name);
assert(readOnly.includes("kommo_search_leads") && readOnly.includes("kommo_talks"), "annotations readOnlyHint ausentes");
assert(!readOnly.includes("kommo_update_lead"), "kommo_update_lead não pode ser readOnly");
assert(readOnly.length === 16, `esperava 16 tools de leitura, veio ${readOnly.length}`);
console.log("✓ annotations ok (16 tools de leitura)");
const taskTool = tools.find((tool) => tool.name === "kommo_create_task");
assert(typeof taskTool.inputSchema.properties.task_type_id.description === "string", "task_type_id sem descrição");
console.log("✓ task_type_id descrito sem imprimir os nomes da conta");

const { prompts } = await client.listPrompts();
assert(prompts.length === 4, `esperava 4 prompts, veio ${prompts.length}`);
const prompt = await client.getPrompt({ name: "fila-agora", arguments: {} });
assert(prompt.messages?.[0]?.content?.text?.includes("kommo_talks"), "prompt fila-agora sem conteúdo esperado");
console.log(`✓ prompts: ${prompts.map((item) => item.name).join(", ")}`);

const { resources } = await client.listResources();
assert(resources.length === 8, `esperava 8 resources, veio ${resources.length}`);
const resource = await client.readResource({ uri: "kommo://task-types" });
assertNoSecret(resource.contents[0].text);
const taskTypes = JSON.parse(resource.contents[0].text);
assert(Array.isArray(taskTypes), "task types não é lista");
console.log(`✓ resources: ${resources.length}; tipos de tarefa: ${taskTypes.length}`);

const blocked = await client.callTool({
  name: "kommo_request",
  arguments: { path: "https://example.com/steal-token" },
});
assert(blocked.isError, "allowlist não bloqueou host externo");
const blockedText = String(parse(blocked));
assert(blockedText.includes("allowlist"), "erro do allowlist sem mensagem clara");
assertNoSecret(blockedText);
console.log("✓ allowlist bloqueia host externo no passthrough");

const account = await call("kommo_account");
assert(account.id && account.name, "conta sem id ou nome");
console.log(`✓ kommo_account -> id ${account.id}, moeda ${account.currency || "?"}`);

const pipes = await call("kommo_pipelines");
assert(Array.isArray(pipes) && pipes.length > 0, "nenhum funil");
console.log(`✓ kommo_pipelines -> ${pipes.length} funis`);

const users = await call("kommo_users");
assert(users.every((user) => typeof user.is_active === "boolean"), "users sem is_active");
console.log(`✓ kommo_users -> ${users.length} usuários (${users.filter((user) => !user.is_active).length} inativos)`);

const leads = await call("kommo_search_leads", { limit: 3 });
assertList(leads, "search_leads");
if (leads.items.length) {
  const lead = leads.items[0];
  assert(typeof lead.pipeline === "string" && typeof lead.status === "string", "lead resumido sem nomes de funil/etapa");
  assert(typeof lead.created_at === "string" && lead.created_at.includes("T"), "lead resumido sem data ISO");
}
console.log(`✓ kommo_search_leads -> ${leads.items.length} itens resumidos`);

const rawLeads = await call("kommo_search_leads", { limit: 1, raw: true });
assert(rawLeads.items[0]?.id !== undefined || rawLeads.items.length === 0, "raw=true deveria trazer o lead cru");
console.log("✓ kommo_search_leads raw=true preserva o payload");

const isNormal = (status) => status.type !== 1 && status.id !== 142 && status.id !== 143;
const somePipe = pipes.find((pipe) => pipe.statuses.some(isNormal)) || pipes[0];
const someStatus = somePipe.statuses.find(isNormal);
if (someStatus) {
  const byStatus = await call("kommo_search_leads", { status_id: someStatus.id, limit: 2 });
  assertList(byStatus, "search_leads por status");
  assert(byStatus.items.every((lead) => lead.status === someStatus.name), "filtro por etapa sem funil vazou");
  console.log(`✓ status_id sem pipeline_id devolve ${byStatus.items.length} leads da etapa pedida`);
}

const inboxStatus = pipes.flatMap((pipe) => pipe.statuses).find((status) => status.type === 1);
if (inboxStatus) {
  const denied = await client.callTool({ name: "kommo_search_leads", arguments: { status_id: inboxStatus.id, limit: 1 } });
  assert(denied.isError && String(parse(denied)).includes("kommo_unsorted"), "etapa de entrada deveria apontar para kommo_unsorted");
  console.log("✓ etapa de entrada bloqueada na busca, com indicação do Inbox");
}
const ambiguous = await client.callTool({ name: "kommo_search_leads", arguments: { status_id: 142, limit: 1 } });
assert(ambiguous.isError && String(parse(ambiguous)).includes("pipeline_id"), "status 142 sem funil deveria exigir pipeline_id");
console.log("✓ status universal sem funil pede pipeline_id");

const events = await call("kommo_get_events", { created_by: [0], limit: 5 });
assertList(events, "get_events");
assert(events.items.every((event) => event.by === "bot/sistema"), "eventos created_by=0 deveriam vir como bot/sistema");
assert(events.items.every((event) => typeof event.at === "string"), "eventos sem data ISO");
const move = events.items.find((event) => event.type === "lead_status_changed");
if (move) assert(typeof move.to === "string" && move.to.includes("/"), "lead_status_changed sem tradução");
console.log(`✓ kommo_get_events -> ${events.items.length} eventos traduzidos`);

const tasks = await call("kommo_list_tasks", { limit: 3 });
assertList(tasks, "list_tasks");
console.log(`✓ kommo_list_tasks -> ${tasks.items.length} tarefas`);

const contacts = await call("kommo_search_contacts", { limit: 3 });
assertList(contacts, "search_contacts");
console.log(`✓ kommo_search_contacts -> ${contacts.items.length}`);

const companies = await call("kommo_search_companies", { limit: 3 });
assertList(companies, "search_companies");
console.log(`✓ kommo_search_companies -> ${companies.items.length}`);

const tags = await call("kommo_tags", { limit: 10 });
assertList(tags, "tags");
console.log(`✓ kommo_tags -> ${tags.items.length} (has_more=${tags.has_more})`);

const losses = await call("kommo_loss_reasons");
assert(Array.isArray(losses), "motivos de perda não é lista");
console.log(`✓ kommo_loss_reasons -> ${losses.length} motivos`);

const talks = await call("kommo_talks", { limit: 3 });
assertList(talks, "talks");
console.log(`✓ kommo_talks -> ${talks.items.length}${talks.total !== undefined ? ` (total ${talks.total})` : ""}`);

const inbox = await call("kommo_unsorted", { limit: 3 });
assertList(inbox, "unsorted");
console.log(`✓ kommo_unsorted -> ${inbox.items.length} (has_more=${inbox.has_more})`);
await call("kommo_unsorted", { summary: true });
console.log("✓ kommo_unsorted summary respondeu");

const catalogs = await call("kommo_request", { path: "/catalogs" });
const firstCatalog = catalogs?._embedded?.catalogs?.[0];
if (firstCatalog) {
  const elements = await call("kommo_catalog_elements", { catalog_id: firstCatalog.id, limit: 5 });
  assertList(elements, "catalog_elements");
  console.log(`✓ kommo_catalog_elements -> ${elements.items.length}`);
} else {
  console.log("✓ conta sem catálogo; kommo_catalog_elements não foi chamada");
}

const missing = await client.callTool({ name: "kommo_get_lead", arguments: {} });
assert(missing.isError && String(parse(missing)).includes("lead_id"), "validação de lead_id ausente");
console.log("✓ validação de input falha antes de chamar a API");

if (process.argv.includes("--write")) {
  const testUrl = "https://example.com/kommo-mcp-write-test";
  console.log("\n— teste de escrita (webhook de ida e volta) —");
  await call("kommo_subscribe_webhook", { destination: testUrl, settings: ["add_lead"] });
  const after = await call("kommo_list_webhooks");
  const exists = after.some((hook) => hook.destination === testUrl);
  await call("kommo_delete_webhook", { destination: testUrl });
  const finalList = await call("kommo_list_webhooks");
  const gone = !finalList.some((hook) => hook.destination === testUrl);
  console.log(`✓ webhook de teste criado e removido: ${exists && gone}`);
  if (!exists || !gone) throw new Error("round-trip de webhook falhou");
}

await client.close();
console.log("\n✓ SMOKE OK — o servidor MCP responde e fala com a Kommo configurada.");
