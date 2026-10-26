#!/usr/bin/env node
import { start } from "./src/server.mjs";

start().catch((err) => {
  console.error(`[kommo-mcp] ${err?.message || err}`);
  process.exit(1);
});
