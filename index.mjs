#!/usr/bin/env node
// Servidor MCP da Kommo CRM (stdio). Expõe leads, etapas, tarefas, responsáveis,
// eventos (auditoria de bots), contatos, conversas, Inbox, tags, catálogo e um
// passthrough genérico da API v4 (restrito por allowlist de hosts).
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  kommo, config, cached, invalidateCache, chunk,
  getPipelines, getStatusMap, getUsers, getUserMap, getCustomFields,
  getAccountInfo, toUnix, isoInTz,
} from "./kommo.mjs";

const RO = { readOnlyHint: true, openWorldHint: false };            // leitura
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };  // cria/adiciona
const WD = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };  // sobrescreve/remove

const TOOLS = [
  {
    name: "kommo_account",
    description: "Dados da conta Kommo (id, nome, subdomínio, moeda, fuso). Use para confirmar conexão.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Dados da conta", ...RO },
  },
  {
    name: "kommo_pipelines",
    description: "Lista todos os funis e suas etapas (id, nome, ordem). Use para descobrir pipeline_id/status_id antes de criar ou mover leads.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Funis e etapas", ...RO },
  },
  {
    name: "kommo_users",
    description: "Lista usuários (id, nome, email, is_active, is_admin). NUNCA atribua leads a usuário com is_active=false.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Usuários", ...RO },
  },
  {
    name: "kommo_custom_fields",
    description: "Lista campos personalizados de uma entidade (leads/contacts/companies). Use para achar field_id (ex.: campos 'N8N | ...' de tracking).",
    inputSchema: {
      type: "object",
      properties: { entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" } },
    },
    annotations: { title: "Campos personalizados", ...RO },
  },
  {
    name: "kommo_search_leads",
    description: "Busca leads. Retorna {items, page, has_more} com resumo legível (funil/etapa/responsável por NOME, telefone do contato principal, datas no fuso da conta). query precisa de 3+ caracteres. Use raw=true para o payload cru da API e fields=[nomes ou ids de campos custom] para projetar valores específicos.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto livre (nome, telefone, etc.). Mínimo 3 caracteres." },
        pipeline_id: { type: "integer" },
        status_id: { type: "integer", description: "Pode vir sem pipeline_id: o funil é resolvido automaticamente." },
        responsible_user_id: { type: "integer" },
        created_from: { type: "string", description: "ISO ou epoch" },
        created_to: { type: "string" },
        updated_from: { type: "string" },
        updated_to: { type: "string" },
        order_by: { type: "string", enum: ["created_at", "updated_at", "id"] },
        order_dir: { type: "string", enum: ["asc", "desc"], default: "desc" },
        fields: { type: "array", items: {}, description: "Campos custom a projetar (nome ou id)" },
        raw: { type: "boolean", default: false },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
    annotations: { title: "Buscar leads", ...RO },
  },
  {
    name: "kommo_get_lead",
    description: "Detalhe completo (cru) de um lead por id, com contatos, motivo de perda e itens de catálogo. Use note_limit>0 para anexar as últimas notas.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "integer" },
        note_limit: { type: "integer", default: 0, description: "Quantas notas recentes anexar (0 = nenhuma)" },
      },
      required: ["lead_id"],
    },
    annotations: { title: "Detalhe do lead", ...RO },
  },
  {
    name: "kommo_create_lead",
    description: "Cria um lead. Opcionalmente já vincula um contato (nome + telefone), seta campos custom e tags.",
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
        tags: { type: "array", items: { type: "string" }, description: "Nomes de tags (cria se não existir)" },
        custom_fields_values: {
          type: "array",
          description: "Formato Kommo: [{field_id, values:[{value}]}]",
          items: { type: "object" },
        },
      },
      required: ["name"],
    },
    annotations: { title: "Criar lead", ...W },
  },
  {
    name: "kommo_update_lead",
    description: "Atualiza um lead: mover de etapa/funil (status_id/pipeline_id), preço, responsável, nome, campos custom, motivo de perda e tags (tags_to_add/tags_to_remove preservam as demais).",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "integer" },
        name: { type: "string" },
        price: { type: "integer" },
        status_id: { type: "integer" },
        pipeline_id: { type: "integer" },
        responsible_user_id: { type: "integer" },
        loss_reason_id: { type: "integer", description: "Ao fechar como perdido (status 143)" },
        tags_to_add: { type: "array", items: { type: "string" } },
        tags_to_remove: { type: "array", items: { type: "string" } },
        custom_fields_values: { type: "array", items: { type: "object" } },
      },
      required: ["lead_id"],
    },
    annotations: { title: "Atualizar lead", ...WD, idempotentHint: true },
  },
  {
    name: "kommo_change_responsible",
    description: "Troca o responsável de um ou vários leads de uma vez (lote com fatiamento automático). Confira antes com kommo_users se o novo responsável está ativo.",
    inputSchema: {
      type: "object",
      properties: {
        lead_ids: { type: "array", items: { type: "integer" } },
        responsible_user_id: { type: "integer" },
      },
      required: ["lead_ids", "responsible_user_id"],
    },
    annotations: { title: "Trocar responsável (lote)", ...WD, idempotentHint: true },
  },
  {
    name: "kommo_bulk_update_leads",
    description: "Atualiza VÁRIOS leads de uma vez (mover etapa/funil, responsável, preço, motivo de perda, tags) com fatiamento automático em blocos de 200 e relatório de sucesso/falha por bloco. Prefira esta tool a repetir kommo_update_lead em série.",
    inputSchema: {
      type: "object",
      properties: {
        lead_ids: { type: "array", items: { type: "integer" } },
        status_id: { type: "integer" },
        pipeline_id: { type: "integer" },
        responsible_user_id: { type: "integer" },
        price: { type: "integer" },
        loss_reason_id: { type: "integer" },
        tags_to_add: { type: "array", items: { type: "string" }, description: "Preserva as tags existentes de cada lead" },
      },
      required: ["lead_ids"],
    },
    annotations: { title: "Atualizar leads em lote", ...WD, idempotentHint: true },
  },
  {
    name: "kommo_add_note",
    description: "Adiciona uma nota a um lead (ou contato/empresa). note_type: common (padrão), call_in, call_out (registrar ligação; use params_extra para uniq/duration/source conforme a API).",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "integer" },
        text: { type: "string" },
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        note_type: { type: "string", enum: ["common", "call_in", "call_out"], default: "common" },
        params_extra: { type: "object", description: "Campos extras do params da nota (ex.: duration, source, phone para call_in/out)" },
      },
      required: ["entity_id", "text"],
    },
    annotations: { title: "Adicionar nota", ...W },
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
        task_type_id: { type: "integer", description: "Tipo da tarefa (veja lista na descrição da tool ou em kommo://task-types)." },
      },
      required: ["text"],
    },
    annotations: { title: "Criar tarefa", ...W },
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
    annotations: { title: "Concluir tarefa", ...WD, idempotentHint: true },
  },
  {
    name: "kommo_list_tasks",
    description: "Lista tarefas resumidas (responsável por nome, prazo no fuso da conta). Retorna {items, page, has_more}.",
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
    annotations: { title: "Listar tarefas", ...RO },
  },
  {
    name: "kommo_get_events",
    description: "Feed de eventos (auditoria) TRADUZIDO: etapas e responsáveis por nome, autor resolvido (created_by=0 = bot/automação), datas no fuso da conta. Essencial para entender o que bots fizeram. Tipos comuns: lead_status_changed, entity_responsible_changed, lead_added, incoming_chat_message. raw=true devolve o payload cru.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["lead", "contact", "company", "task"], description: "Tipo de entidade do evento" },
        entity_id: { type: "integer", description: "Restringe a uma entidade específica" },
        type: { type: "array", items: { type: "string" }, description: "Tipos de evento (ex.: lead_status_changed)" },
        created_by: { type: "array", items: { type: "integer" }, description: "Filtra por autor. 0 = bot/sistema." },
        from: { type: "string", description: "Data inicial (ISO ou epoch)" },
        to: { type: "string", description: "Data final (ISO ou epoch)" },
        raw: { type: "boolean", default: false },
        limit: { type: "integer", default: 100, maximum: 100 },
        page: { type: "integer", default: 1 },
      },
    },
    annotations: { title: "Eventos (auditoria)", ...RO },
  },
  {
    name: "kommo_search_contacts",
    description: "Busca contatos por texto (nome, telefone, email). Retorna {items, page, has_more} resumidos (telefone/email extraídos). raw=true para o cru.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        raw: { type: "boolean", default: false },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
    annotations: { title: "Buscar contatos", ...RO },
  },
  {
    name: "kommo_create_status",
    description: "Cria uma nova ETAPA dentro de um funil. Informe pipeline_id, name e opcionalmente sort/color.",
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
    annotations: { title: "Criar etapa", ...W },
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
    annotations: { title: "Atualizar etapa", ...WD, idempotentHint: true },
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
    annotations: { title: "Criar contato", ...W },
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
    annotations: { title: "Atualizar contato", ...WD, idempotentHint: true },
  },
  {
    name: "kommo_search_companies",
    description: "Busca empresas por texto. Retorna {items, page, has_more} resumidos. raw=true para o cru.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        raw: { type: "boolean", default: false },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
    annotations: { title: "Buscar empresas", ...RO },
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
    annotations: { title: "Criar empresa", ...W },
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
    annotations: { title: "Atualizar empresa", ...WD, idempotentHint: true },
  },
  {
    name: "kommo_link",
    description: "Vincula uma entidade a outra: contato↔lead, empresa↔lead/contato e catalog_elements↔lead (produto/procedimento; use catalog_id e quantity).",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["leads", "contacts", "companies"] },
        entity_id: { type: "integer" },
        to_entity_type: { type: "string", enum: ["leads", "contacts", "companies", "catalog_elements"] },
        to_entity_id: { type: "integer" },
        catalog_id: { type: "integer", description: "Obrigatório quando to_entity_type=catalog_elements" },
        quantity: { type: "integer", description: "Quantidade (para catalog_elements)", default: 1 },
      },
      required: ["entity", "entity_id", "to_entity_type", "to_entity_id"],
    },
    annotations: { title: "Vincular entidades", ...W },
  },
  {
    name: "kommo_list_webhooks",
    description: "Lista os webhooks configurados na conta (destino e eventos assinados).",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Listar webhooks", ...RO },
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
    annotations: { title: "Assinar webhook", ...W, openWorldHint: true },
  },
  {
    name: "kommo_delete_webhook",
    description: "Remove (cancela) um webhook pela URL de destino.",
    inputSchema: {
      type: "object",
      properties: { destination: { type: "string" } },
      required: ["destination"],
    },
    annotations: { title: "Remover webhook", ...WD },
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
    annotations: { title: "Criar campo custom", ...W },
  },
  {
    name: "kommo_update_custom_field",
    description: "Atualiza um campo personalizado: renomear e/ou ADICIONAR opções a um select/multiselect com add_enums (preserva as opções existentes).",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        field_id: { type: "integer" },
        name: { type: "string" },
        add_enums: { type: "array", items: { type: "string" }, description: "Novas opções a acrescentar (ignora duplicadas)" },
      },
      required: ["field_id"],
    },
    annotations: { title: "Atualizar campo custom", ...WD, idempotentHint: true },
  },
  {
    name: "kommo_tags",
    description: "Lista as tags de uma entidade (id, nome, cor), com busca por texto. Para APLICAR tags use tags_to_add em kommo_update_lead ou kommo_bulk_update_leads (tag inexistente é criada na hora).",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        query: { type: "string", description: "Filtra por nome" },
        limit: { type: "integer", default: 100, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
    annotations: { title: "Listar tags", ...RO },
  },
  {
    name: "kommo_loss_reasons",
    description: "Lista os motivos de perda configurados na conta (id, nome). Combine com kommo_search_leads (status_id=143) para relatório de perdas.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Motivos de perda", ...RO },
  },
  {
    name: "kommo_talks",
    description: "Fila de conversas (chats) da conta em tempo real: quem está aguardando atendimento AGORA. Filtre is_in_work=true para conversas em andamento e is_read=false para não lidas. Retorna {items, page, has_more}.",
    inputSchema: {
      type: "object",
      properties: {
        is_in_work: { type: "boolean", description: "true = em atendimento" },
        is_read: { type: "boolean", description: "false = não lidas" },
        contact_id: { type: "integer" },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
    annotations: { title: "Fila de conversas", ...RO },
  },
  {
    name: "kommo_close_talk",
    description: "Fecha uma conversa (talk) pelo talk_id.",
    inputSchema: {
      type: "object",
      properties: {
        talk_id: { type: "integer" },
        force_close: { type: "boolean", default: true, description: "true fecha direto; false dispara o fluxo de encerramento (NPS etc.)" },
      },
      required: ["talk_id"],
    },
    annotations: { title: "Fechar conversa", ...WD },
  },
  {
    name: "kommo_unsorted",
    description: "Inbox de leads não distribuídos (etapa de entrada). Lista o que chegou e ainda não virou card aceito: útil para achar lead esquecido na porta. summary=true devolve o resumo agregado da fila.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["sip", "mail", "forms", "chats"], description: "Origem do item" },
        pipeline_id: { type: "integer" },
        summary: { type: "boolean", default: false, description: "true = agregado (totais) em vez da lista" },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
    annotations: { title: "Inbox (não distribuídos)", ...RO },
  },
  {
    name: "kommo_unsorted_accept",
    description: "Aceita um item do Inbox (vira lead ativo). Opcional: user_id (responsável) e status_id (etapa de destino).",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string" },
        user_id: { type: "integer" },
        status_id: { type: "integer" },
      },
      required: ["uid"],
    },
    annotations: { title: "Aceitar item do Inbox", ...W },
  },
  {
    name: "kommo_unsorted_decline",
    description: "Rejeita (descarta) um item do Inbox pelo uid. Ação difícil de desfazer: confirme antes.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string" },
        user_id: { type: "integer" },
      },
      required: ["uid"],
    },
    annotations: { title: "Rejeitar item do Inbox", ...WD },
  },
  {
    name: "kommo_catalog_elements",
    description: "Lista elementos de um catálogo (ex.: produtos/procedimentos do catálogo 'Produtos'). Descubra o catalog_id com kommo_request GET /catalogs.",
    inputSchema: {
      type: "object",
      properties: {
        catalog_id: { type: "integer" },
        query: { type: "string" },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
      required: ["catalog_id"],
    },
    annotations: { title: "Elementos do catálogo", ...RO },
  },
  {
    name: "kommo_create_catalog_element",
    description: "Cria um elemento num catálogo (ex.: um procedimento com preço). Use custom_fields_values para campos do catálogo (ex.: PRICE).",
    inputSchema: {
      type: "object",
      properties: {
        catalog_id: { type: "integer" },
        name: { type: "string" },
        custom_fields_values: { type: "array", items: { type: "object" } },
      },
      required: ["catalog_id", "name"],
    },
    annotations: { title: "Criar elemento de catálogo", ...W },
  },
  {
    name: "kommo_run_salesbot",
    description: "DISPARA um Salesbot num lead específico (o lead RECEBE MENSAGENS reais). SEMPRE confirme com o usuário antes de chamar. O bot_id aparece na URL da UI ao editar o bot. Nunca use em lote sem autorização explícita.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "integer" },
        entity_id: { type: "integer", description: "Id do lead" },
        entity_type: { type: "integer", default: 2, description: "2 = lead (padrão)" },
      },
      required: ["bot_id", "entity_id"],
    },
    annotations: { title: "Disparar Salesbot", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "kommo_upload_file",
    description: "Sobe um arquivo local para o drive da conta e, se entity_id for informado, anexa ao lead/contato/empresa.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Caminho local absoluto do arquivo" },
        file_name: { type: "string", description: "Nome no drive (default: nome do arquivo)" },
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        entity_id: { type: "integer", description: "Se informado, anexa o arquivo a esta entidade" },
      },
      required: ["file_path"],
    },
    annotations: { title: "Enviar arquivo", ...W },
  },
  {
    name: "kommo_request",
    description: "Passthrough genérico autenticado da API da Kommo para endpoints não cobertos pelas tools. path relativo à v4 (ex.: '/catalogs') ou URL absoluta restrita a hosts *.kommo.com da conta. Cuidado: PATCH/POST/DELETE alteram dados.",
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
    annotations: { title: "Chamada genérica à API", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

// ---- Helpers de resumo ----------------------------------------------------

function need(a, key, type) {
  const v = a[key];
  if (v === undefined || v === null) throw new Error(`Parâmetro obrigatório ausente: ${key}`);
  if (type === "int" && !Number.isInteger(Number(v))) throw new Error(`Parâmetro ${key} deve ser inteiro (recebi: ${JSON.stringify(v)})`);
  if (type === "array" && !Array.isArray(v)) throw new Error(`Parâmetro ${key} deve ser array`);
  return type === "int" ? Number(v) : v;
}

function listShape(d, key, page) {
  return {
    items: d?._embedded?.[key] || [],
    page: d?._page ?? page ?? 1,
    has_more: !!d?._links?.next,
  };
}

function firstLossReason(embedded) {
  const lr = embedded?.loss_reason;
  if (!lr) return undefined;
  return Array.isArray(lr) ? lr[0]?.name : lr.name;
}

function cfValue(entity, fieldId) {
  const f = entity.custom_fields_values?.find((v) => v.field_id === fieldId);
  if (!f) return undefined;
  return f.values?.map((x) => x.value).join(", ");
}

function cfByCode(entity, code) {
  const f = entity.custom_fields_values?.find((v) => v.field_code === code);
  return f?.values?.[0]?.value;
}

function fmtResponsible(userMap, id) {
  const u = userMap.get(id);
  if (!u) return id;
  return u.is_active ? u.name : `${u.name} (inativo)`;
}

async function summarizeLeads(leads, fields) {
  const [statusMap, userMap, acc] = await Promise.all([getStatusMap(), getUserMap(), getAccountInfo()]);
  const tz = acc.timezone;

  // Resolve os contatos principais em lote (nome + telefone).
  const contactIds = [...new Set(
    leads.flatMap((l) => (l._embedded?.contacts || []).filter((c) => c.is_main !== false).map((c) => c.id))
  )];
  const contactsById = new Map();
  try {
    for (const part of chunk(contactIds, 250)) {
      const d = await kommo("GET", "/contacts", { query: { filter: { id: part }, limit: 250 } });
      for (const c of d?._embedded?.contacts || []) {
        contactsById.set(c.id, { id: c.id, name: c.name, phone: cfByCode(c, "PHONE") });
      }
    }
  } catch { /* resumo segue sem telefone */ }

  // Projeção de campos custom pedidos por nome ou id.
  let fieldDefs = null;
  if (fields?.length) {
    const defs = await getCustomFields("leads");
    fieldDefs = fields
      .map((f) => Number.isInteger(f) || /^\d+$/.test(String(f))
        ? defs.find((d) => d.id === Number(f))
        : defs.find((d) => d.name.toLowerCase() === String(f).toLowerCase()))
      .filter(Boolean);
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

async function summarizeEvents(events) {
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
      case "lead_status_changed": {
        out.from = fmtStatusChange(statusMap, e.value_before);
        out.to = fmtStatusChange(statusMap, e.value_after);
        break;
      }
      case "entity_responsible_changed": {
        const b = e.value_before?.[0]?.responsible_user?.id;
        const a2 = e.value_after?.[0]?.responsible_user?.id;
        if (b !== undefined) out.from = userMap.get(b)?.name || `user#${b}`;
        if (a2 !== undefined) out.to = userMap.get(a2)?.name || `user#${a2}`;
        break;
      }
      case "lead_added":
      case "contact_added":
      case "company_added":
        break; // o próprio type já diz tudo
      case "entity_tag_added":
      case "entity_tag_removed": {
        const tag = e.value_after?.[0]?.tag?.name || e.value_before?.[0]?.tag?.name;
        if (tag) out.tag = tag;
        break;
      }
      case "incoming_chat_message":
      case "outgoing_chat_message":
        break; // o texto da mensagem não vem pela API de eventos
      default: {
        if (e.value_before?.length) out.before = e.value_before;
        if (e.value_after?.length) out.after = e.value_after;
      }
    }
    return out;
  });
}

async function getLossReasons() {
  return cached("loss_reasons", 5 * 60_000, async () => {
    const d = await kommo("GET", "/leads/loss_reasons");
    return (d?._embedded?.loss_reasons || []).map((r) => ({ id: r.id, name: r.name }));
  });
}

// Monta a lista final de tags de um lead a partir das atuais + add/remove.
function mergeTags(currentTags, toAdd = [], toRemove = []) {
  const rm = new Set(toRemove.map((s) => String(s).toLowerCase()));
  const kept = (currentTags || [])
    .filter((t) => !rm.has(t.name.toLowerCase()))
    .map((t) => ({ id: t.id }));
  const have = new Set((currentTags || []).filter((t) => !rm.has(t.name.toLowerCase())).map((t) => t.name.toLowerCase()));
  for (const name of toAdd) {
    if (!have.has(String(name).toLowerCase())) kept.push({ name: String(name) });
  }
  return kept.length ? kept : null; // null desvincula todas
}

const MIME = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".txt": "text/plain", ".csv": "text/csv",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4",
};

// ---- Implementações ----

async function handle(name, a = {}) {
  switch (name) {
    case "kommo_account":
      return await kommo("GET", "/account");

    case "kommo_pipelines":
      return await getPipelines();

    case "kommo_users":
      return await getUsers();

    case "kommo_custom_fields":
      return await getCustomFields(a.entity || "leads");

    case "kommo_search_leads": {
      const page = a.page || 1;
      const query = { with: "contacts,loss_reason", limit: a.limit || 50, page };
      if (a.query) query.query = a.query;
      const filter = {};
      if (a.status_id) {
        const statusMap = await getStatusMap();
        let pid = a.pipeline_id;
        if (!pid) {
          const st = statusMap.get(a.status_id);
          if (!st) throw new Error(`status_id ${a.status_id} não existe em nenhum funil. Confira com kommo_pipelines.`);
          if (st.ambiguous) throw new Error(`status_id ${a.status_id} existe em mais de um funil (ex.: 142/143 são universais). Informe também pipeline_id.`);
          pid = st.pipeline_id;
        }
        const entry = statusMap.get(`${pid}:${a.status_id}`);
        if (entry?.type === 1) {
          throw new Error(`A etapa "${entry.status}" é a etapa de entrada (Inbox): a API não filtra /leads por ela. Use kommo_unsorted.`);
        }
        filter.statuses = [{ pipeline_id: pid, status_id: a.status_id }];
      } else if (a.pipeline_id) {
        filter.pipeline_id = a.pipeline_id;
      }
      if (a.responsible_user_id) filter.responsible_user_id = a.responsible_user_id;
      if (a.created_from || a.created_to) {
        filter.created_at = {};
        if (a.created_from) filter.created_at.from = toUnix(a.created_from);
        if (a.created_to) filter.created_at.to = toUnix(a.created_to);
      }
      if (a.updated_from || a.updated_to) {
        filter.updated_at = {};
        if (a.updated_from) filter.updated_at.from = toUnix(a.updated_from);
        if (a.updated_to) filter.updated_at.to = toUnix(a.updated_to);
      }
      if (Object.keys(filter).length) query.filter = filter;
      if (a.order_by) query.order = { [a.order_by]: a.order_dir || "desc" };
      const d = await kommo("GET", "/leads", { query });
      const shape = listShape(d, "leads", page);
      if (!a.raw) shape.items = await summarizeLeads(shape.items, a.fields);
      return shape;
    }

    case "kommo_get_lead": {
      const id = need(a, "lead_id", "int");
      const lead = await kommo("GET", `/leads/${id}`, {
        query: { with: "contacts,catalog_elements,loss_reason,source_id" },
      });
      if (a.note_limit && a.note_limit > 0) {
        const notes = await kommo("GET", `/leads/${id}/notes`, {
          query: { limit: a.note_limit, order: { created_at: "desc" } },
        });
        lead._notes = notes?._embedded?.notes || [];
      }
      return lead;
    }

    case "kommo_create_lead": {
      const base = { name: need(a, "name") };
      if (a.price !== undefined) base.price = a.price;
      if (a.pipeline_id) base.pipeline_id = a.pipeline_id;
      if (a.status_id) base.status_id = a.status_id;
      if (a.responsible_user_id) base.responsible_user_id = a.responsible_user_id;
      if (a.custom_fields_values) base.custom_fields_values = a.custom_fields_values;
      if (a.tags?.length) base._embedded = { tags: a.tags.map((t) => ({ name: String(t) })) };

      if (a.contact_name || a.contact_phone) {
        const contact = { first_name: a.contact_name || a.name };
        if (a.contact_phone) {
          contact.custom_fields_values = [
            { field_code: "PHONE", values: [{ value: a.contact_phone, enum_code: "WORK" }] },
          ];
        }
        base._embedded = { ...(base._embedded || {}), contacts: [contact] };
        return await kommo("POST", "/leads/complex", { body: [base] });
      }
      return await kommo("POST", "/leads", { body: [base] });
    }

    case "kommo_update_lead": {
      const id = need(a, "lead_id", "int");
      const body = { id };
      for (const k of ["name", "price", "status_id", "pipeline_id", "responsible_user_id", "loss_reason_id", "custom_fields_values"]) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      if (a.tags_to_add?.length || a.tags_to_remove?.length) {
        const cur = await kommo("GET", `/leads/${id}`);
        body._embedded = { tags: mergeTags(cur._embedded?.tags, a.tags_to_add, a.tags_to_remove) };
      }
      return await kommo("PATCH", `/leads/${id}`, { body });
    }

    case "kommo_change_responsible": {
      const ids = need(a, "lead_ids", "array");
      const rid = need(a, "responsible_user_id", "int");
      const result = { updated: 0, failed: [] };
      for (const part of chunk(ids, 200)) {
        try {
          const d = await kommo("PATCH", "/leads", { body: part.map((id) => ({ id, responsible_user_id: rid })) });
          result.updated += d?._embedded?.leads?.length ?? part.length;
        } catch (e) {
          result.failed.push({ lead_ids: part, error: e.message });
        }
      }
      return result;
    }

    case "kommo_bulk_update_leads": {
      const ids = need(a, "lead_ids", "array");
      if (!ids.length) throw new Error("lead_ids vazio.");
      const patch = {};
      for (const k of ["status_id", "pipeline_id", "responsible_user_id", "price", "loss_reason_id"]) {
        if (a[k] !== undefined) patch[k] = a[k];
      }
      if (!Object.keys(patch).length && !a.tags_to_add?.length) {
        throw new Error("Nada para atualizar: informe status_id/pipeline_id/responsible_user_id/price/loss_reason_id ou tags_to_add.");
      }
      const result = { updated: 0, failed: [], chunks: 0 };
      for (const part of chunk(ids, 200)) {
        result.chunks++;
        try {
          let bodies;
          if (a.tags_to_add?.length) {
            // Tags são substituídas por inteiro no PATCH: lê as atuais para preservar.
            const cur = await kommo("GET", "/leads", { query: { filter: { id: part }, limit: 250 } });
            const byId = new Map((cur?._embedded?.leads || []).map((l) => [l.id, l]));
            bodies = part.map((id) => ({
              id,
              ...patch,
              _embedded: { tags: mergeTags(byId.get(id)?._embedded?.tags, a.tags_to_add, []) },
            }));
          } else {
            bodies = part.map((id) => ({ id, ...patch }));
          }
          const d = await kommo("PATCH", "/leads", { body: bodies });
          result.updated += d?._embedded?.leads?.length ?? part.length;
        } catch (e) {
          result.failed.push({ lead_ids: part, error: e.message });
        }
      }
      return result;
    }

    case "kommo_add_note": {
      const entity = a.entity || "leads";
      const noteType = a.note_type || "common";
      const params = { text: need(a, "text"), ...(a.params_extra || {}) };
      const body = [{ note_type: noteType, params }];
      return await kommo("POST", `/${entity}/${need(a, "entity_id", "int")}/notes`, { body });
    }

    case "kommo_create_task": {
      const entity = a.entity || "leads";
      const completeTill = a.complete_till ? toUnix(a.complete_till) : Math.floor(Date.now() / 1000) + 86400;
      const task = { text: need(a, "text"), complete_till: completeTill, entity_type: entity };
      if (a.entity_id) task.entity_id = a.entity_id;
      if (a.responsible_user_id) task.responsible_user_id = a.responsible_user_id;
      if (a.task_type_id) task.task_type_id = a.task_type_id;
      return await kommo("POST", "/tasks", { body: [task] });
    }

    case "kommo_complete_task": {
      const body = { is_completed: true };
      if (a.result) body.result = { text: a.result };
      return await kommo("PATCH", `/tasks/${need(a, "task_id", "int")}`, { body });
    }

    case "kommo_list_tasks": {
      const page = a.page || 1;
      const query = { limit: a.limit || 50, page };
      const filter = {};
      if (a.responsible_user_id) filter.responsible_user_id = a.responsible_user_id;
      if (a.entity_id) filter.entity_id = a.entity_id;
      if (a.entity_type) filter.entity_type = a.entity_type;
      if (a.is_completed !== undefined) filter.is_completed = a.is_completed ? 1 : 0;
      if (Object.keys(filter).length) query.filter = filter;
      const d = await kommo("GET", "/tasks", { query });
      const shape = listShape(d, "tasks", page);
      const [userMap, acc] = await Promise.all([getUserMap(), getAccountInfo()]);
      shape.items = shape.items.map((t) => ({
        id: t.id,
        text: t.text,
        entity: `${t.entity_type}#${t.entity_id}`,
        responsible: fmtResponsible(userMap, t.responsible_user_id),
        task_type_id: t.task_type_id,
        is_completed: t.is_completed,
        complete_till: isoInTz(t.complete_till, acc.timezone),
        created_at: isoInTz(t.created_at, acc.timezone),
        result: t.result?.text || undefined,
      }));
      return shape;
    }

    case "kommo_get_events": {
      const page = a.page || 1;
      const query = { limit: a.limit || 100, page, with: "contact_name,lead_name" };
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
      const shape = listShape(d, "events", page);
      if (!a.raw) shape.items = await summarizeEvents(shape.items);
      return shape;
    }

    case "kommo_search_contacts": {
      const page = a.page || 1;
      const query = { limit: a.limit || 50, page };
      if (a.query) query.query = a.query;
      const d = await kommo("GET", "/contacts", { query });
      const shape = listShape(d, "contacts", page);
      if (!a.raw) {
        const [userMap, acc] = await Promise.all([getUserMap(), getAccountInfo()]);
        shape.items = shape.items.map((c) => ({
          id: c.id,
          name: c.name,
          phone: cfByCode(c, "PHONE"),
          email: cfByCode(c, "EMAIL"),
          responsible: fmtResponsible(userMap, c.responsible_user_id),
          created_at: isoInTz(c.created_at, acc.timezone),
          lead_ids: (c._embedded?.leads || []).map((l) => l.id),
        }));
      }
      return shape;
    }

    case "kommo_search_companies": {
      const page = a.page || 1;
      const query = { limit: a.limit || 50, page };
      if (a.query) query.query = a.query;
      const d = await kommo("GET", "/companies", { query });
      const shape = listShape(d, "companies", page);
      if (!a.raw) {
        const [userMap, acc] = await Promise.all([getUserMap(), getAccountInfo()]);
        shape.items = shape.items.map((c) => ({
          id: c.id,
          name: c.name,
          phone: cfByCode(c, "PHONE"),
          responsible: fmtResponsible(userMap, c.responsible_user_id),
          created_at: isoInTz(c.created_at, acc.timezone),
        }));
      }
      return shape;
    }

    case "kommo_create_status": {
      const status = { name: need(a, "name") };
      if (a.sort !== undefined) status.sort = a.sort;
      if (a.color) status.color = a.color;
      const r = await kommo("POST", `/leads/pipelines/${need(a, "pipeline_id", "int")}/statuses`, { body: [status] });
      invalidateCache("pipelines");
      return r;
    }

    case "kommo_update_status": {
      const body = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.sort !== undefined) body.sort = a.sort;
      if (a.color) body.color = a.color;
      const r = await kommo("PATCH", `/leads/pipelines/${need(a, "pipeline_id", "int")}/statuses/${need(a, "status_id", "int")}`, { body });
      invalidateCache("pipelines");
      return r;
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
      const id = need(a, "contact_id", "int");
      const body = { id };
      for (const k of ["name", "first_name", "last_name", "responsible_user_id", "custom_fields_values"]) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      return await kommo("PATCH", `/contacts/${id}`, { body });
    }

    case "kommo_create_company": {
      const c = { name: need(a, "name") };
      if (a.responsible_user_id) c.responsible_user_id = a.responsible_user_id;
      if (a.custom_fields_values) c.custom_fields_values = a.custom_fields_values;
      return await kommo("POST", "/companies", { body: [c] });
    }

    case "kommo_update_company": {
      const id = need(a, "company_id", "int");
      const body = { id };
      for (const k of ["name", "responsible_user_id", "custom_fields_values"]) {
        if (a[k] !== undefined) body[k] = a[k];
      }
      return await kommo("PATCH", `/companies/${id}`, { body });
    }

    case "kommo_link": {
      const link = { to_entity_id: need(a, "to_entity_id", "int"), to_entity_type: need(a, "to_entity_type") };
      if (a.to_entity_type === "catalog_elements") {
        link.metadata = { catalog_id: need(a, "catalog_id", "int"), quantity: a.quantity ?? 1 };
      }
      return await kommo("POST", `/${need(a, "entity")}/${need(a, "entity_id", "int")}/link`, { body: [link] });
    }

    case "kommo_list_webhooks": {
      const d = await kommo("GET", "/webhooks");
      return d?._embedded?.webhooks || [];
    }

    case "kommo_subscribe_webhook":
      return await kommo("POST", "/webhooks", { body: { destination: need(a, "destination"), settings: need(a, "settings", "array") } });

    case "kommo_delete_webhook":
      return await kommo("DELETE", "/webhooks", { body: { destination: need(a, "destination") } });

    case "kommo_create_custom_field": {
      const entity = a.entity || "leads";
      const field = { name: need(a, "name"), type: a.type || "text" };
      if (a.enums && a.enums.length) field.enums = a.enums.map((v, i) => ({ value: v, sort: (i + 1) * 10 }));
      const r = await kommo("POST", `/${entity}/custom_fields`, { body: [field] });
      invalidateCache(`cf:${entity}`);
      return r;
    }

    case "kommo_update_custom_field": {
      const entity = a.entity || "leads";
      const fieldId = need(a, "field_id", "int");
      const body = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.add_enums?.length) {
        const cur = await kommo("GET", `/${entity}/custom_fields/${fieldId}`);
        if (!["select", "multiselect", "radiobutton"].includes(cur.type)) {
          throw new Error(`Campo "${cur.name}" é do tipo ${cur.type} e não aceita enums.`);
        }
        const existing = (cur.enums || []).map((e) => ({ id: e.id, value: e.value, sort: e.sort }));
        const known = new Set(existing.map((e) => e.value.toLowerCase()));
        let maxSort = Math.max(0, ...existing.map((e) => e.sort || 0));
        body.enums = [...existing];
        for (const v of a.add_enums) {
          if (!known.has(String(v).toLowerCase())) body.enums.push({ value: String(v), sort: (maxSort += 10) });
        }
      }
      if (!Object.keys(body).length) throw new Error("Nada para atualizar: informe name e/ou add_enums.");
      const r = await kommo("PATCH", `/${entity}/custom_fields/${fieldId}`, { body });
      invalidateCache(`cf:${entity}`);
      return r;
    }

    case "kommo_tags": {
      const entity = a.entity || "leads";
      const page = a.page || 1;
      const query = { limit: a.limit || 100, page };
      if (a.query) query.query = a.query;
      const d = await kommo("GET", `/${entity}/tags`, { query });
      const shape = listShape(d, "tags", page);
      shape.items = shape.items.map((t) => ({ id: t.id, name: t.name, color: t.color || undefined }));
      return shape;
    }

    case "kommo_loss_reasons":
      return await getLossReasons();

    case "kommo_talks": {
      const page = a.page || 1;
      const query = { limit: a.limit || 50, page };
      const filter = {};
      if (a.is_in_work !== undefined) filter.is_in_work = a.is_in_work ? 1 : 0;
      if (a.is_read !== undefined) filter.is_read = a.is_read ? 1 : 0;
      if (a.contact_id) filter.contact_id = a.contact_id;
      if (Object.keys(filter).length) query.filter = filter;
      const d = await kommo("GET", "/talks", { query });
      const shape = listShape(d, "talks", page);
      if (d?._total_items !== undefined) shape.total = d._total_items;
      const acc = await getAccountInfo();
      shape.items = shape.items.map((t) => ({
        talk_id: t.talk_id,
        status: t.status,
        is_in_work: t.is_in_work,
        is_read: t.is_read,
        origin: t.origin,
        contact_id: t.contact_id,
        lead_id: t.entity_type === "lead" ? t.entity_id : undefined,
        entity: t.entity_type ? `${t.entity_type}#${t.entity_id}` : undefined,
        created_at: isoInTz(t.created_at, acc.timezone),
        updated_at: isoInTz(t.updated_at, acc.timezone),
      }));
      return shape;
    }

    case "kommo_close_talk": {
      await kommo("POST", `/talks/${need(a, "talk_id", "int")}/close`, {
        body: { force_close: a.force_close ?? true },
      });
      return { ok: true, talk_id: a.talk_id };
    }

    case "kommo_unsorted": {
      const page = a.page || 1;
      if (a.summary) {
        return await kommo("GET", "/leads/unsorted/summary");
      }
      const query = { limit: a.limit || 50, page };
      const filter = {};
      if (a.category) filter.category = [a.category];
      if (a.pipeline_id) filter.pipeline_id = [a.pipeline_id];
      if (Object.keys(filter).length) query.filter = filter;
      const d = await kommo("GET", "/leads/unsorted", { query });
      const shape = listShape(d, "unsorted", page);
      const [pipes, acc] = await Promise.all([getPipelines(), getAccountInfo()]);
      const pipeName = new Map(pipes.map((p) => [p.id, p.name]));
      shape.items = shape.items.map((u) => ({
        uid: u.uid,
        category: u.category,
        source_name: u.source_name,
        pipeline: pipeName.get(u.pipeline_id) || u.pipeline_id,
        created_at: isoInTz(u.created_at, acc.timezone),
        from: u.metadata?.client?.name || u.metadata?.from || undefined,
        last_message_at: typeof u.metadata?.last_message_text === "number"
          ? isoInTz(u.metadata.last_message_text, acc.timezone)
          : undefined,
        lead_ids: (u._embedded?.leads || []).map((l) => l.id),
        contact_ids: (u._embedded?.contacts || []).map((c) => c.id),
      }));
      return shape;
    }

    case "kommo_unsorted_accept": {
      const body = {};
      if (a.user_id) body.user_id = a.user_id;
      if (a.status_id) body.status_id = a.status_id;
      return await kommo("POST", `/leads/unsorted/${encodeURIComponent(need(a, "uid"))}/accept`, { body });
    }

    case "kommo_unsorted_decline": {
      const body = {};
      if (a.user_id) body.user_id = a.user_id;
      return await kommo("DELETE", `/leads/unsorted/${encodeURIComponent(need(a, "uid"))}/decline`, { body });
    }

    case "kommo_catalog_elements": {
      const page = a.page || 1;
      const catalogId = need(a, "catalog_id", "int");
      const query = { limit: a.limit || 50, page };
      if (a.query) query.query = a.query;
      const d = await kommo("GET", `/catalogs/${catalogId}/elements`, { query });
      const shape = listShape(d, "elements", page);
      shape.items = shape.items.map((el) => {
        const custom = {};
        for (const f of el.custom_fields_values || []) {
          custom[f.field_name || f.field_code || f.field_id] = f.values?.map((v) => v.value).join(", ");
        }
        return { id: el.id, name: el.name, ...(Object.keys(custom).length ? { custom } : {}) };
      });
      return shape;
    }

    case "kommo_create_catalog_element": {
      const el = { name: need(a, "name") };
      if (a.custom_fields_values) el.custom_fields_values = a.custom_fields_values;
      return await kommo("POST", `/catalogs/${need(a, "catalog_id", "int")}/elements`, { body: [el] });
    }

    case "kommo_run_salesbot": {
      const body = [{
        bot_id: need(a, "bot_id", "int"),
        entity_id: need(a, "entity_id", "int"),
        entity_type: a.entity_type ?? 2,
      }];
      return await kommo("POST", `https://${config.SUBDOMAIN}.kommo.com/api/v2/salesbot/run`, { body });
    }

    case "kommo_upload_file": {
      const filePath = need(a, "file_path");
      const buf = readFileSync(filePath);
      if (!buf.length) throw new Error("Arquivo vazio.");
      const fileName = a.file_name || basename(filePath);
      const acc = await getAccountInfo();
      if (!acc.drive_url) throw new Error("Conta sem drive_url configurado.");
      const session = await kommo("POST", `${acc.drive_url}/v1.0/sessions`, {
        body: {
          file_name: fileName,
          file_size: buf.length,
          content_type: MIME[extname(fileName).toLowerCase()] || "application/octet-stream",
        },
      });
      let uploadUrl = session.upload_url;
      const partSize = session.max_part_size || buf.length;
      let fileInfo = null;
      for (let off = 0; off < buf.length; off += partSize) {
        const part = buf.subarray(off, Math.min(off + partSize, buf.length));
        const r = await kommo("POST", uploadUrl, {
          body: part,
          headers: { "Content-Type": "application/octet-stream" },
          timeoutMs: 120_000,
        });
        if (r?.next_url) uploadUrl = r.next_url;
        else fileInfo = r;
      }
      if (!fileInfo?.uuid) throw new Error(`Upload terminou sem uuid do arquivo: ${JSON.stringify(fileInfo)}`);
      const out = { file: { uuid: fileInfo.uuid, name: fileInfo.name || fileName, size: buf.length } };
      if (a.entity_id) {
        const entity = a.entity || "leads";
        await kommo("PUT", `/${entity}/${a.entity_id}/files`, { body: [{ file_uuid: fileInfo.uuid }] });
        out.attached_to = `${entity}#${a.entity_id}`;
      }
      return out;
    }

    case "kommo_request":
      return await kommo(a.method || "GET", need(a, "path"), { query: a.query, body: a.body });

    default:
      throw new Error(`Tool desconhecida: ${name}`);
  }
}

// ---- Prompts (viram slash commands no cliente MCP) ------------------------

const PROMPTS = [
  {
    name: "auditoria-do-dia",
    description: "Auditoria do que bots e automações fizeram no CRM nas últimas horas",
    arguments: [{ name: "horas", description: "Janela em horas (default 24)", required: false }],
    build: (args) => `Audite o que bots e automações fizeram na Kommo nas últimas ${args?.horas || 24} horas.
1. Use kommo_get_events com created_by=[0] e from apropriado (pagine se has_more).
2. Agrupe por tipo de evento e por lead; conte volumes.
3. Destaque: movimentos de etapa em ping-pong (mesmo lead indo e voltando), trocas de responsável inesperadas, volume anormal comparado ao padrão.
4. Para leads suspeitos, puxe kommo_get_lead com note_limit=5 para contexto.
Termine com um veredito: normal ou anomalia, e o que investigar na UI (cenários de Salesbot só são editáveis lá).`,
  },
  {
    name: "fila-agora",
    description: "Foto do atendimento neste momento: conversas abertas e Inbox",
    arguments: [],
    build: () => `Tire uma foto do atendimento AGORA na Kommo:
1. kommo_talks com is_read=false e depois is_in_work=true (pagine se has_more).
2. kommo_unsorted (lista) e kommo_unsorted com summary=true.
3. Para cada conversa/item parado, identifique o lead (kommo_get_lead se precisar) e há quanto tempo espera.
Apresente: total aguardando, os 10 mais antigos com nome/telefone/tempo de espera, e recomendação de ação (quem deve assumir). Atenção a janelas sem cobertura humana (fins de semana, fora do horário comercial).`,
  },
  {
    name: "leads-parados",
    description: "Leads sem atividade há N dias, por funil/etapa",
    arguments: [
      { name: "dias", description: "Dias sem atualização (default 7)", required: false },
      { name: "pipeline_id", description: "Restringir a um funil (opcional)", required: false },
    ],
    build: (args) => `Encontre leads parados na Kommo: sem NENHUMA atualização há ${args?.dias || 7}+ dias.
1. kommo_pipelines para mapear funis/etapas ativos.
2. kommo_search_leads com updated_to = hoje menos ${args?.dias || 7} dias, order_by=updated_at asc${args?.pipeline_id ? `, pipeline_id=${args.pipeline_id}` : ""} (ignore etapas fechadas 142/143; pagine se has_more).
3. Agrupe por etapa e por responsável (atenção a responsável inativo).
Apresente uma tabela: etapa, quantidade, os mais antigos (nome, telefone, dias parado, responsável) e sugestão de próxima ação por grupo.`,
  },
  {
    name: "relatorio-perdas",
    description: "Relatório de leads perdidos por motivo, num período",
    arguments: [
      { name: "inicio", description: "Data inicial (ISO, ex.: 2026-06-01)", required: false },
      { name: "fim", description: "Data final (ISO)", required: false },
    ],
    build: (args) => `Monte um relatório de perdas na Kommo${args?.inicio ? ` de ${args.inicio}` : " do mês atual"}${args?.fim ? ` até ${args.fim}` : ""}.
1. kommo_loss_reasons para os motivos configurados.
2. kommo_search_leads com status_id=143 (perdido) e updated_from/updated_to no período, paginando até o fim (has_more).
3. Agrupe por loss_reason (o resumo já traz o nome), depois por funil e por responsável.
Apresente: total de perdas, ranking de motivos com %, destaque de mudanças vs. período anterior se dados permitirem, e 3 recomendações acionáveis (ex.: motivo "Não compareceu" alto = reforçar confirmação).`,
  },
];

// ---- Resources (dados quase estáticos, baratos de consultar) ---------------

const RESOURCES = [
  { uri: "kommo://account", name: "Conta", description: "Dados da conta: fuso, moeda, drive, tipos de tarefa" },
  { uri: "kommo://pipelines", name: "Funis e etapas", description: "Todos os funis com suas etapas (ids e nomes)" },
  { uri: "kommo://users", name: "Usuários", description: "Usuários com is_active/is_admin" },
  { uri: "kommo://custom-fields/leads", name: "Campos custom de leads", description: "Campos personalizados de leads" },
  { uri: "kommo://custom-fields/contacts", name: "Campos custom de contatos", description: "Campos personalizados de contatos" },
  { uri: "kommo://custom-fields/companies", name: "Campos custom de empresas", description: "Campos personalizados de empresas" },
  { uri: "kommo://loss-reasons", name: "Motivos de perda", description: "Motivos de perda configurados" },
  { uri: "kommo://task-types", name: "Tipos de tarefa", description: "Tipos de tarefa ativos na conta (ids reais)" },
];

async function readResource(uri) {
  switch (uri) {
    case "kommo://account": return getAccountInfo();
    case "kommo://pipelines": return getPipelines();
    case "kommo://users": return getUsers();
    case "kommo://custom-fields/leads": return getCustomFields("leads");
    case "kommo://custom-fields/contacts": return getCustomFields("contacts");
    case "kommo://custom-fields/companies": return getCustomFields("companies");
    case "kommo://loss-reasons": return getLossReasons();
    case "kommo://task-types": return (await getAccountInfo()).task_types;
    default: throw new Error(`Resource desconhecido: ${uri}`);
  }
}

// ---- Server ----------------------------------------------------------------

const server = new Server(
  { name: "kommo", version: "2.0.0" },
  {
    capabilities: { tools: {}, prompts: {}, resources: {} },
    instructions: `Servidor MCP da conta Kommo "${config.SUBDOMAIN}". Listagens devolvem {items, page, has_more}: pagine enquanto has_more=true. IDs de funil/etapa/usuário: kommo_pipelines e kommo_users (nunca atribua a usuário inativo). Datas de entrada aceitam ISO ou epoch; saídas resumidas vêm no fuso da conta. Antes de escrever em lote ou disparar Salesbot, confirme com o usuário.`,
  }
);

// A descrição de kommo_create_task ganha os tipos de tarefa REAIS da conta.
async function buildTools() {
  try {
    const acc = await getAccountInfo();
    if (!acc.task_types?.length) return TOOLS;
    const list = acc.task_types.map((t) => `${t.id}=${t.name}`).join(", ");
    return TOOLS.map((t) =>
      t.name === "kommo_create_task"
        ? {
            ...t,
            inputSchema: {
              ...t.inputSchema,
              properties: {
                ...t.inputSchema.properties,
                task_type_id: { type: "integer", description: `Tipo da tarefa. Nesta conta: ${list}.` },
              },
            },
          }
        : t
    );
  } catch {
    return TOOLS; // offline: descrição estática
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await buildTools() }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const t0 = Date.now();
  try {
    const result = await handle(name, args || {});
    console.error(`[kommo-mcp] ${name} ok ${Date.now() - t0}ms`);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    console.error(`[kommo-mcp] ${name} ERRO ${Date.now() - t0}ms: ${err.message}`);
    return {
      isError: true,
      content: [{ type: "text", text: `ERRO em ${name}: ${err.message}${err.body ? "\n" + JSON.stringify(err.body) : ""}` }],
    };
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const p = PROMPTS.find((x) => x.name === req.params.name);
  if (!p) throw new Error(`Prompt desconhecido: ${req.params.name}`);
  return {
    description: p.description,
    messages: [{ role: "user", content: { type: "text", text: p.build(req.params.arguments || {}) } }],
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES.map((r) => ({ ...r, mimeType: "application/json" })),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const data = await readResource(req.params.uri);
  return {
    contents: [{ uri: req.params.uri, mimeType: "application/json", text: JSON.stringify(data) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[kommo-mcp] conectado a ${config.SUBDOMAIN}.kommo.com — ${TOOLS.length} tools, ${PROMPTS.length} prompts, ${RESOURCES.length} resources`);
