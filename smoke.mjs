// Smoke test end-to-end: sobe o server via stdio e chama tools read-only contra a API real.
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
const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
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

const { tools } = await client.listTools();
console.log(`\n✓ tools expostas: ${tools.length}`);
console.log("  " + tools.map((t) => t.name).join(", "));

const acc = await call("kommo_account");
console.log(`\n✓ kommo_account -> ${acc.name} (id ${acc.id}, ${acc.currency})`);

const pipes = await call("kommo_pipelines");
console.log(`✓ kommo_pipelines -> ${pipes.length} funis; principal: ${pipes.find((p) => p.is_main)?.name}`);

const users = await call("kommo_users");
console.log(`✓ kommo_users -> ${users.length} usuários: ${users.map((u) => u.name).join(", ")}`);

const leads = await call("kommo_search_leads", { limit: 3 });
console.log(`✓ kommo_search_leads(limit 3) -> ${leads.length} leads; ex.: ${leads.map((l) => `#${l.id} "${l.name}"`).join(" | ") || "(vazio)"}`);

// Eventos de bot/sistema (created_by = 0) — exatamente o caso de auditoria de bots.
const ev = await call("kommo_get_events", { created_by: [0], limit: 5 });
console.log(`✓ kommo_get_events(created_by=0, limit 5) -> ${ev.length} eventos de bot/sistema`);
for (const e of ev.slice(0, 5)) {
  console.log(`    • ${e.type}  entity=${e.entity_type}#${e.entity_id}  by=${e.created_by}  at=${e.created_at}`);
}

await client.close();
console.log("\n✓ SMOKE OK — server MCP responde via protocolo e fala com a Kommo real.");
