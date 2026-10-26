import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const skip = new Set([".git", "node_modules", "package-lock.json"]);

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) files(path, out);
    else if (info.size < 1_000_000) out.push(path);
  }
  return out;
}

const banned = [
  ["n", "8", "n"],
  ["interesse", " em ", "agendar"],
  ["next", "bas"],
  ["g", "mail.com"],
  ["hot", "mail"],
  ["out", "look.com"],
  ["guil", "herme"],
  ["paci", "ente"],
  ["procedi", "mento"],
  ["ey", "Jhb"],
].map((parts) => new RegExp(parts.join(""), "i"));

test("árvore do projeto não carrega segredo nem dado de uma operação", () => {
  const hits = [];
  for (const path of files(root)) {
    const text = readFileSync(path, "utf8");
    for (const pattern of banned) {
      if (pattern.test(text)) hits.push(`${path} combina com um termo que não pode estar no repositório`);
    }
  }
  assert.deepEqual(hits, []);
});
