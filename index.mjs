#!/usr/bin/env node
// Servidor MCP da Kommo CRM (stdio). Expõe leads, etapas, tarefas, responsáveis,
// eventos (auditoria de bots), contatos e um passthrough genérico da API v4.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { kommo, getPipelines, getUsers, toUnix, config } from "./kommo.mjs";

const TOOLS = [
  {
    name: "kommo_account",
    description: "Dados da conta Kommo (id, nome, subdomínio, moeda, fuso). Use para confirmar conexão.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kommo_pipelines",
    description: "Lista todos os funis e suas etapas (id, nome, ordem). Use para descobrir pipeline_id/status_id antes de criar ou mover leads.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kommo_users",
    description: "Lista usuários (id, nome, email). Use para mapear nome -> responsible_user_id ao trocar responsáveis.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kommo_custom_fields",
    description: "Lista campos personalizados de uma entidade (leads/contacts/companies). Use para achar field_id (ex.: campos 'N8N | ...' de tracking).",
    inputSchema: {
      type: "object",
      properties: { entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" } },
    },
  },
  {
    name: "kommo_search_leads",
    description: "Busca leads. Filtra por texto (query), funil, etapa e responsável. Retorna leads com contatos embutidos.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto livre (nome, telefone, etc.)" },
        pipeline_id: { type: "integer" },
        status_id: { type: "integer" },
        responsible_user_id: { type: "integer" },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
  },
  {
    name: "kommo_get_lead",
    description: "Detalhe completo de um lead por id, com contatos. Use note_limit>0 para anexar as últimas notas.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "integer" },
        note_limit: { type: "integer", default: 0, description: "Quantas notas recentes anexar (0 = nenhuma)" },
      },
      required: ["lead_id"],
    },
  },
  {
    name: "kommo_create_lead",
    description: "Cria um lead. Opcionalmente já vincula um contato (nome + telefone) e seta campos custom.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        price: { type: "integer" },
        pipeline_id: { type: "integer" },
        status_id: { type: "integer" },
        responsible_user_id: { type: "integer" },
        contact_name: { type: "string" },
        contact_phone: { type: "string" },
        custom_fields_values: {
          type: "array",
          description: "Formato Kommo: [{field_id, values:[{value}]}]",
          items: { type: "object" },
        },
      },
      required: ["name"],
    },
  },
  {
    name: "kommo_update_lead",
    description: "Atualiza um lead: mover de etapa/funil (status_id/pipeline_id), preço, responsável, nome ou campos custom.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "integer" },
        name: { type: "string" },
        price: { type: "integer" },
        status_id: { type: "integer" },
        pipeline_id: { type: "integer" },
        responsible_user_id: { type: "integer" },
        custom_fields_values: { type: "array", items: { type: "object" } },
      },
      required: ["lead_id"],
    },
  },
  {
    name: "kommo_change_responsible",
    description: "Troca o responsável de um ou vários leads de uma vez (operação em lote).",
    inputSchema: {
      type: "object",
      properties: {
        lead_ids: { type: "array", items: { type: "integer" } },
        responsible_user_id: { type: "integer" },
      },
      required: ["lead_ids", "responsible_user_id"],
    },
  },
  {
    name: "kommo_add_note",
    description: "Adiciona uma nota de texto a um lead (ou contato/empresa).",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "integer" },
        text: { type: "string" },
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
      },
      required: ["entity_id", "text"],
    },
  },
  {
    name: "kommo_create_task",
    description: "Cria uma tarefa vinculada a um lead (ou outra entidade), com prazo e responsável.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        entity_id: { type: "integer" },
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        complete_till: { type: "string", description: "Prazo: ISO (2026-06-26T15:00) ou epoch. Default: +1 dia." },
        responsible_user_id: { type: "integer" },
        task_type_id: { type: "integer", description: "Tipo (1=contato, 2=reunião...). Opcional." },
      },
      required: ["text"],
    },
  },
  {
    name: "kommo_complete_task",
    description: "Marca uma tarefa como concluída, opcionalmente com texto de resultado.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        result: { type: "string" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "kommo_list_tasks",
    description: "Lista tarefas. Filtra por responsável, entidade e status (concluída ou não).",
    inputSchema: {
      type: "object",
      properties: {
        responsible_user_id: { type: "integer" },
        entity_id: { type: "integer" },
        entity_type: { type: "string", enum: ["leads", "contacts", "companies"] },
        is_completed: { type: "boolean" },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
  },
  {
    name: "kommo_get_events",
    description: "Feed de eventos (auditoria). Essencial para ENTENDER BOTS: quem mudou o quê, quando. Filtre created_by=0 para ações de bot/automação nativa. Tipos comuns: lead_status_changed, entity_responsible_changed, lead_added, incoming_chat_message.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["lead", "contact", "company", "task"], description: "Tipo de entidade do evento" },
        entity_id: { type: "integer", description: "Restringe a uma entidade específica" },
        type: { type: "array", items: { type: "string" }, description: "Tipos de evento (ex.: lead_status_changed)" },
        created_by: { type: "array", items: { type: "integer" }, description: "Filtra por autor. 0 = bot/sistema." },
        from: { type: "string", description: "Data inicial (ISO ou epoch)" },
        to: { type: "string", description: "Data final (ISO ou epoch)" },
        limit: { type: "integer", default: 100, maximum: 100 },
        page: { type: "integer", default: 1 },
      },
    },
  },
  {
    name: "kommo_search_contacts",
    description: "Busca contatos por texto (nome, telefone, email).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
  },
  {
    name: "kommo_create_status",
    description: "Cria uma nova ETAPA dentro de um funil (desenvolver etapas). Informe pipeline_id, name e opcionalmente sort/color.",
    inputSchema: {
      type: "object",
      properties: {
        pipeline_id: { type: "integer" },
        name: { type: "string" },
        sort: { type: "integer", description: "Posição na ordem" },
        color: { type: "string", description: "Hex da cor, ex.: #fffeb2" },
      },
      required: ["pipeline_id", "name"],
    },
  },
  {
    name: "kommo_update_status",
    description: "Renomeia/reordena/recolore uma etapa existente.",
    inputSchema: {
      type: "object",
      properties: {
        pipeline_id: { type: "integer" },
        status_id: { type: "integer" },
        name: { type: "string" },
        sort: { type: "integer" },
        color: { type: "string" },
      },
      required: ["pipeline_id", "status_id"],
    },
  },
  {
    name: "kommo_create_contact",
    description: "Cria um contato. Telefone/email viram custom fields PHONE/EMAIL automaticamente.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nome completo (ou use first_name/last_name)" },
        first_name: { type: "string" },
        last_name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        responsible_user_id: { type: "integer" },
        custom_fields_values: { type: "array", items: { type: "object" } },
      },
    },
  },
  {
    name: "kommo_update_contact",
    description: "Atualiza um contato existente (nome, responsável, campos custom).",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "integer" },
        name: { type: "string" },
        first_name: { type: "string" },
        last_name: { type: "string" },
        responsible_user_id: { type: "integer" },
        custom_fields_values: { type: "array", items: { type: "object" } },
      },
      required: ["contact_id"],
    },
  },
  {
    name: "kommo_search_companies",
    description: "Busca empresas por texto (nome, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
  },
  {
    name: "kommo_create_company",
    description: "Cria uma empresa.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        responsible_user_id: { type: "integer" },
        custom_fields_values: { type: "array", items: { type: "object" } },
      },
      required: ["name"],
    },
  },
  {
    name: "kommo_update_company",
    description: "Atualiza uma empresa existente.",
    inputSchema: {
      type: "object",
      properties: {
        company_id: { type: "integer" },
        name: { type: "string" },
        responsible_user_id: { type: "integer" },
        custom_fields_values: { type: "array", items: { type: "object" } },
      },
      required: ["company_id"],
    },
  },
  {
    name: "kommo_link",
    description: "Vincula uma entidade a outra (ex.: contato↔lead, empresa↔lead/contato).",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["leads", "contacts", "companies"] },
        entity_id: { type: "integer" },
        to_entity_type: { type: "string", enum: ["leads", "contacts", "companies"] },
        to_entity_id: { type: "integer" },
      },
      required: ["entity", "entity_id", "to_entity_type", "to_entity_id"],
    },
  },
  {
    name: "kommo_list_webhooks",
    description: "Lista os webhooks configurados na conta (destino e eventos assinados).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kommo_subscribe_webhook",
    description: "Assina um webhook: envia eventos da Kommo para uma URL. settings = lista de eventos (ex.: add_lead, status_lead, update_lead, add_contact, add_task).",
    inputSchema: {
      type: "object",
      properties: {
        destination: { type: "string", description: "URL HTTPS que receberá os eventos" },
        settings: { type: "array", items: { type: "string" }, description: "Eventos a assinar" },
      },
      required: ["destination", "settings"],
    },
  },
  {
    name: "kommo_delete_webhook",
    description: "Remove (cancela) um webhook pela URL de destino.",
    inputSchema: {
      type: "object",
      properties: { destination: { type: "string" } },
      required: ["destination"],
    },
  },
  {
    name: "kommo_create_custom_field",
    description: "Cria um campo personalizado numa entidade. type: text, numeric, select, multiselect, date, url, checkbox, textarea, etc. Para select/multiselect, passe enums.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        name: { type: "string" },
        type: { type: "string", default: "text" },
        enums: { type: "array", items: { type: "string" }, description: "Opções (para select/multiselect)" },
      },
      required: ["name"],
    },
  },
  {
    name: "kommo_update_custom_field",
    description: "Atualiza um campo personalizado (renomear, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        field_id: { type: "integer" },
        name: { type: "string" },
      },
      required: ["field_id"],
    },
  },
  {
    name: "kommo_request",
    description: "Passthrough genérico autenticado da API v4 da Kommo, para qualquer coisa não coberta pelas tools acima. path relativo (ex.: '/companies'). Cuidado: PATCH/POST/DELETE alteram dados.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"], default: "GET" },
        path: { type: "string", description: "Ex.: /leads/123 ou /companies?limit=10" },
        query: { type: "object", description: "Params de query (objeto; suporta arrays e filter aninhado)" },
        body: { description: "Corpo JSON para POST/PATCH" },
      },
      required: ["path"],
    },
  },
];

// ---- Implementações ----
async function handle(name, a = {}) {
  switch (name) {
    case "kommo_account":
      return await kommo("GET", "/account");

    case "kommo_pipelines":
      return await getPipelines();

    case "kommo_users":
      return await getUsers();

    case "kommo_custom_fields": {
      const entity = a.entity || "leads";
      const d = await kommo("GET", `/${entity}/custom_fields`, { query: { limit: 250 } });
      return (d?._embedded?.custom_fields || []).map((f) => ({
        id: f.id, name: f.name, type: f.type, code: f.code,
        enums: f.enums?.map((e) => ({ id: e.id, value: e.value })),
      }));
    }

    case "kommo_search_leads": {
      const query = { with: "contacts", limit: a.limit || 50, page: a.page || 1 };
      if (a.query) query.query = a.query;
      const filter = {};
      if (a.pipeline_id) filter.pipeline_id = a.pipeline_id;
      if (a.status_id) filter.statuses = [{ pipeline_id: a.pipeline_id, status_id: a.status_id }];
      if (a.responsible_user_id) filter.responsible_user_id = a.responsible_user_id;
      if (Object.keys(filter).length) query.filter = filter;
      const d = await kommo("GET", "/leads", { query });
      return d?._embedded?.leads || [];
    }

    case "kommo_get_lead": {
      const lead = await kommo("GET", `/leads/${a.lead_id}`, { query: { with: "contacts,catalog_elements" } });
      if (a.note_limit && a.note_limit > 0) {
        const notes = await kommo("GET", `/leads/${a.lead_id}/notes`, {
          query: { limit: a.note_limit, order: { created_at: "desc" } },
        });
        lead._notes = notes?._embedded?.notes || [];
      }
      return lead;
    }

    case "kommo_create_lead": {
      const base = { name: a.name };
      if (a.price !== undefined) base.price = a.price;
      if (a.pipeline_id) base.pipeline_id = a.pipeline_id;
      if (a.status_id) base.status_id = a.status_id;
      if (a.responsible_user_id) base.responsible_user_id = a.responsible_user_id;
      if (a.custom_fields_values) base.custom_fields_values = a.custom_fields_values;

      if (a.contact_name || a.contact_phone) {
        const contact = { first_name: a.contact_name || a.name };
        if (a.contact_phone) {
          contact.custom_fields_values = [
            { field_code: "PHONE", values: [{ value: a.contact_phone, enum_code: "WORK" }] },
          ];
        }
        base._embedded = { contacts: [contact] };
        return await kommo("POST", "/leads/complex", { body: [base] });
      }
      return await kommo("POST", "/leads", { body: [base] });
    }

    case "kommo_update_lead": {
      const body = { id: a.lead_id };
      for (const k of ["name", "price", "status_id", "pipeline_id", "responsible_user_id", "custom_fields_values"]) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      return await kommo("PATCH", `/leads/${a.lead_id}`, { body });
    }

    case "kommo_change_responsible": {
      const body = a.lead_ids.map((id) => ({ id, responsible_user_id: a.responsible_user_id }));
      return await kommo("PATCH", "/leads", { body });
    }

    case "kommo_add_note": {
      const entity = a.entity || "leads";
      const body = [{ note_type: "common", params: { text: a.text } }];
      return await kommo("POST", `/${entity}/${a.entity_id}/notes`, { body });
    }

    case "kommo_create_task": {
      const entity = a.entity || "leads";
      const completeTill = a.complete_till ? toUnix(a.complete_till) : Math.floor(Date.now() / 1000) + 86400;
      const task = { text: a.text, complete_till: completeTill, entity_type: entity };
      if (a.entity_id) task.entity_id = a.entity_id;
      if (a.responsible_user_id) task.responsible_user_id = a.responsible_user_id;
      if (a.task_type_id) task.task_type_id = a.task_type_id;
      return await kommo("POST", "/tasks", { body: [task] });
    }

    case "kommo_complete_task": {
      const body = { is_completed: true };
      if (a.result) body.result = { text: a.result };
      return await kommo("PATCH", `/tasks/${a.task_id}`, { body });
    }

    case "kommo_list_tasks": {
      const query = { limit: a.limit || 50, page: a.page || 1 };
      const filter = {};
      if (a.responsible_user_id) filter.responsible_user_id = a.responsible_user_id;
      if (a.entity_id) filter.entity_id = a.entity_id;
      if (a.entity_type) filter.entity_type = a.entity_type;
      if (a.is_completed !== undefined) filter.is_completed = a.is_completed ? 1 : 0;
      if (Object.keys(filter).length) query.filter = filter;
      const d = await kommo("GET", "/tasks", { query });
      return d?._embedded?.tasks || [];
    }

    case "kommo_get_events": {
      const query = { limit: a.limit || 100, page: a.page || 1, with: "contact_name,lead_name" };
      const filter = {};
      if (a.entity) filter.entity = a.entity;
      if (a.entity_id) filter.entity_id = [a.entity_id];
      if (a.type) filter.type = a.type;
      if (a.created_by) filter.created_by = a.created_by;
      if (a.from || a.to) {
        filter.created_at = {};
        if (a.from) filter.created_at.from = toUnix(a.from);
        if (a.to) filter.created_at.to = toUnix(a.to);
      }
      if (Object.keys(filter).length) query.filter = filter;
      const d = await kommo("GET", "/events", { query });
      return d?._embedded?.events || [];
    }

    case "kommo_search_contacts": {
      const query = { limit: a.limit || 50, page: a.page || 1 };
      if (a.query) query.query = a.query;
      const d = await kommo("GET", "/contacts", { query });
      return d?._embedded?.contacts || [];
    }

    case "kommo_create_status": {
      const status = { name: a.name };
      if (a.sort !== undefined) status.sort = a.sort;
      if (a.color) status.color = a.color;
      return await kommo("POST", `/leads/pipelines/${a.pipeline_id}/statuses`, { body: [status] });
    }

    case "kommo_update_status": {
      const body = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.sort !== undefined) body.sort = a.sort;
      if (a.color) body.color = a.color;
      return await kommo("PATCH", `/leads/pipelines/${a.pipeline_id}/statuses/${a.status_id}`, { body });
    }

    case "kommo_create_contact": {
      const c = {};
      if (a.name) c.name = a.name;
      if (a.first_name) c.first_name = a.first_name;
      if (a.last_name) c.last_name = a.last_name;
      if (a.responsible_user_id) c.responsible_user_id = a.responsible_user_id;
      const cfv = [];
      if (a.phone) cfv.push({ field_code: "PHONE", values: [{ value: a.phone, enum_code: "WORK" }] });
      if (a.email) cfv.push({ field_code: "EMAIL", values: [{ value: a.email, enum_code: "WORK" }] });
      if (a.custom_fields_values) cfv.push(...a.custom_fields_values);
      if (cfv.length) c.custom_fields_values = cfv;
      return await kommo("POST", "/contacts", { body: [c] });
    }

    case "kommo_update_contact": {
      const body = { id: a.contact_id };
      for (const k of ["name", "first_name", "last_name", "responsible_user_id", "custom_fields_values"]) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      return await kommo("PATCH", `/contacts/${a.contact_id}`, { body });
    }

    case "kommo_search_companies": {
      const query = { limit: a.limit || 50, page: a.page || 1 };
      if (a.query) query.query = a.query;
      const d = await kommo("GET", "/companies", { query });
      return d?._embedded?.companies || [];
    }

    case "kommo_create_company": {
      const c = { name: a.name };
      if (a.responsible_user_id) c.responsible_user_id = a.responsible_user_id;
      if (a.custom_fields_values) c.custom_fields_values = a.custom_fields_values;
      return await kommo("POST", "/companies", { body: [c] });
    }

    case "kommo_update_company": {
      const body = { id: a.company_id };
      for (const k of ["name", "responsible_user_id", "custom_fields_values"]) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      return await kommo("PATCH", `/companies/${a.company_id}`, { body });
    }

    case "kommo_link":
      return await kommo("POST", `/${a.entity}/${a.entity_id}/link`, {
        body: [{ to_entity_id: a.to_entity_id, to_entity_type: a.to_entity_type }],
      });

    case "kommo_list_webhooks": {
      const d = await kommo("GET", "/webhooks");
      return d?._embedded?.webhooks || [];
    }

    case "kommo_subscribe_webhook":
      return await kommo("POST", "/webhooks", { body: { destination: a.destination, settings: a.settings } });

    case "kommo_delete_webhook":
      return await kommo("DELETE", "/webhooks", { body: { destination: a.destination } });

    case "kommo_create_custom_field": {
      const entity = a.entity || "leads";
      const field = { name: a.name, type: a.type || "text" };
      if (a.enums && a.enums.length) field.enums = a.enums.map((v, i) => ({ value: v, sort: (i + 1) * 10 }));
      return await kommo("POST", `/${entity}/custom_fields`, { body: [field] });
    }

    case "kommo_update_custom_field": {
      const entity = a.entity || "leads";
      const body = {};
      if (a.name !== undefined) body.name = a.name;
      return await kommo("PATCH", `/${entity}/custom_fields/${a.field_id}`, { body });
    }

    case "kommo_request":
      return await kommo(a.method || "GET", a.path, { query: a.query, body: a.body });

    default:
      throw new Error(`Tool desconhecida: ${name}`);
  }
}

const server = new Server(
  { name: "kommo", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await handle(name, args || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `ERRO em ${name}: ${err.message}${err.body ? "\n" + JSON.stringify(err.body) : ""}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[kommo-mcp] conectado a ${config.SUBDOMAIN}.kommo.com — ${TOOLS.length} tools`);
