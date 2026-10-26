// Contratos das tools. O nome e o formato de resposta são estáveis desde a 2.0.

const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const WD = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: "kommo_account",
    description: "Dados da conta Kommo (id, nome, subdomínio, moeda, fuso). Use para confirmar a conexão.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Dados da conta", ...RO },
  },
  {
    name: "kommo_pipelines",
    description: "Lista os funis e as etapas (id, nome, ordem). Use para descobrir pipeline_id e status_id antes de criar ou mover leads.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Funis e etapas", ...RO },
  },
  {
    name: "kommo_users",
    description: "Lista usuários (id, nome, email, is_active, is_admin). Não atribua leads a usuário com is_active=false.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Usuários", ...RO },
  },
  {
    name: "kommo_custom_fields",
    description: "Lista campos personalizados de uma entidade (leads, contacts ou companies). Use para achar field_id antes de gravar um valor.",
    inputSchema: {
      type: "object",
      properties: { entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" } },
    },
    annotations: { title: "Campos personalizados", ...RO },
  },
  {
    name: "kommo_search_leads",
    description: "Busca leads. Retorna {items, page, has_more} com resumo legível (funil, etapa e responsável por nome, telefone do contato principal, datas no fuso da conta). query precisa de 3 ou mais caracteres. raw=true devolve o payload da API. fields projeta campos personalizados por nome ou id.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto livre (nome, telefone, etc.). Mínimo 3 caracteres." },
        pipeline_id: { type: "integer" },
        status_id: { type: "integer", description: "Pode vir sem pipeline_id quando a etapa existe em um único funil." },
        responsible_user_id: { type: "integer" },
        created_from: { type: "string", description: "ISO ou epoch" },
        created_to: { type: "string" },
        updated_from: { type: "string" },
        updated_to: { type: "string" },
        order_by: { type: "string", enum: ["created_at", "updated_at", "id"] },
        order_dir: { type: "string", enum: ["asc", "desc"], default: "desc" },
        fields: { type: "array", items: {}, description: "Campos personalizados a projetar (nome ou id)" },
        raw: { type: "boolean", default: false },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
    annotations: { title: "Buscar leads", ...RO },
  },
  {
    name: "kommo_get_lead",
    description: "Detalhe de um lead por id, com contatos, motivo de perda e itens de catálogo. note_limit maior que 0 anexa as notas mais recentes.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "integer" },
        note_limit: { type: "integer", default: 0, description: "Quantas notas recentes anexar (0 = nenhuma, máximo 50)" },
      },
      required: ["lead_id"],
    },
    annotations: { title: "Detalhe do lead", ...RO },
  },
  {
    name: "kommo_create_lead",
    description: "Cria um lead. Pode vincular um contato (nome e telefone), gravar campos personalizados e aplicar tags.",
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
        tags: { type: "array", items: { type: "string" }, description: "Nomes de tags. A Kommo cria a tag se ela ainda não existir." },
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
    description: "Atualiza um lead: etapa, funil, preço, responsável, nome, campos personalizados, motivo de perda e tags. tags_to_add e tags_to_remove não apagam as demais tags.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "integer" },
        name: { type: "string" },
        price: { type: "integer" },
        status_id: { type: "integer" },
        pipeline_id: { type: "integer" },
        responsible_user_id: { type: "integer" },
        loss_reason_id: { type: "integer", description: "Usado ao marcar o lead como perdido (status 143)" },
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
    description: "Troca o responsável de um ou vários leads. O lote é fatiado automaticamente. Confira em kommo_users se o novo responsável está ativo. Máximo de 1000 ids por chamada.",
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
    description: "Atualiza vários leads de uma vez (etapa, funil, responsável, preço, motivo de perda, tags) em blocos de até 200, com relatório por bloco. Máximo de 1000 ids por chamada.",
    inputSchema: {
      type: "object",
      properties: {
        lead_ids: { type: "array", items: { type: "integer" } },
        status_id: { type: "integer" },
        pipeline_id: { type: "integer" },
        responsible_user_id: { type: "integer" },
        price: { type: "integer" },
        loss_reason_id: { type: "integer" },
        tags_to_add: { type: "array", items: { type: "string" }, description: "Acrescenta tags sem remover as existentes" },
      },
      required: ["lead_ids"],
    },
    annotations: { title: "Atualizar leads em lote", ...WD, idempotentHint: true },
  },
  {
    name: "kommo_add_note",
    description: "Adiciona uma nota a um lead, contato ou empresa. note_type: common (padrão), call_in ou call_out. params_extra aceita duration, source, phone e uniq.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "integer" },
        text: { type: "string" },
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        note_type: { type: "string", enum: ["common", "call_in", "call_out"], default: "common" },
        params_extra: { type: "object", description: "Campos extras da nota, como duration, source e phone" },
      },
      required: ["entity_id", "text"],
    },
    annotations: { title: "Adicionar nota", ...W },
  },
  {
    name: "kommo_create_task",
    description: "Cria uma tarefa vinculada a um lead, contato ou empresa, com prazo e responsável.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        entity_id: { type: "integer" },
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        complete_till: { type: "string", description: "Prazo em ISO ou epoch. Padrão: daqui a 1 dia." },
        responsible_user_id: { type: "integer" },
        task_type_id: { type: "integer", description: "Tipo da tarefa. Veja kommo://task-types." },
      },
      required: ["text"],
    },
    annotations: { title: "Criar tarefa", ...W },
  },
  {
    name: "kommo_complete_task",
    description: "Marca uma tarefa como concluída, com texto de resultado opcional.",
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
    description: "Feed de eventos traduzido: etapas e responsáveis por nome, autor resolvido (created_by=0 é bot ou automação) e datas no fuso da conta. raw=true devolve o payload da API.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["lead", "contact", "company", "task"] },
        entity_id: { type: "integer" },
        type: { type: "array", items: { type: "string" }, description: "Tipos de evento, por exemplo lead_status_changed" },
        created_by: { type: "array", items: { type: "integer" }, description: "Autores. 0 = bot ou sistema." },
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
    description: "Busca contatos por texto (nome, telefone, email). Retorna {items, page, has_more}. raw=true devolve o payload da API.",
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
    description: "Cria uma etapa dentro de um funil.",
    inputSchema: {
      type: "object",
      properties: {
        pipeline_id: { type: "integer" },
        name: { type: "string" },
        sort: { type: "integer" },
        color: { type: "string", description: "Hex, por exemplo #fffeb2" },
      },
      required: ["pipeline_id", "name"],
    },
    annotations: { title: "Criar etapa", ...W },
  },
  {
    name: "kommo_update_status",
    description: "Renomeia, reordena ou troca a cor de uma etapa existente.",
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
    description: "Cria um contato. Telefone e email viram os campos PHONE e EMAIL.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
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
    description: "Atualiza um contato (nome, responsável, campos personalizados).",
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
    description: "Busca empresas por texto. Retorna {items, page, has_more}. raw=true devolve o payload da API.",
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
    description: "Atualiza uma empresa.",
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
    description: "Vincula duas entidades: contato e lead, empresa e lead, ou um item de catálogo e um lead. Para catálogo, informe catalog_id.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["leads", "contacts", "companies"] },
        entity_id: { type: "integer" },
        to_entity_type: { type: "string", enum: ["leads", "contacts", "companies", "catalog_elements"] },
        to_entity_id: { type: "integer" },
        catalog_id: { type: "integer", description: "Obrigatório quando to_entity_type é catalog_elements" },
        quantity: { type: "integer", description: "Quantidade do item de catálogo", default: 1 },
      },
      required: ["entity", "entity_id", "to_entity_type", "to_entity_id"],
    },
    annotations: { title: "Vincular entidades", ...W },
  },
  {
    name: "kommo_list_webhooks",
    description: "Lista os webhooks da conta (destino e eventos assinados).",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Listar webhooks", ...RO },
  },
  {
    name: "kommo_subscribe_webhook",
    description: "Assina um webhook HTTPS. A Kommo passará a enviar eventos de CRM para essa URL. settings é a lista de eventos, por exemplo add_lead e status_lead.",
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
    description: "Remove um webhook pela URL de destino.",
    inputSchema: {
      type: "object",
      properties: { destination: { type: "string" } },
      required: ["destination"],
    },
    annotations: { title: "Remover webhook", ...WD },
  },
  {
    name: "kommo_create_custom_field",
    description: "Cria um campo personalizado. type pode ser text, numeric, select, multiselect, date, url, checkbox, textarea e outros tipos da Kommo. Para select, passe enums.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        name: { type: "string" },
        type: { type: "string", default: "text" },
        enums: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
    },
    annotations: { title: "Criar campo personalizado", ...W },
  },
  {
    name: "kommo_update_custom_field",
    description: "Renomeia um campo personalizado e/ou acrescenta opções a um select, multiselect ou radiobutton. As opções existentes são preservadas.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        field_id: { type: "integer" },
        name: { type: "string" },
        add_enums: { type: "array", items: { type: "string" } },
      },
      required: ["field_id"],
    },
    annotations: { title: "Atualizar campo personalizado", ...WD, idempotentHint: true },
  },
  {
    name: "kommo_tags",
    description: "Lista as tags de uma entidade (id, nome, cor). Para aplicar tags, use tags_to_add em kommo_update_lead ou kommo_bulk_update_leads.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        query: { type: "string" },
        limit: { type: "integer", default: 100, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
    annotations: { title: "Listar tags", ...RO },
  },
  {
    name: "kommo_loss_reasons",
    description: "Lista os motivos de perda da conta (id e nome). Combine com kommo_search_leads e status_id=143 para um relatório de perdas.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Motivos de perda", ...RO },
  },
  {
    name: "kommo_talks",
    description: "Fila de conversas da conta. is_in_work=true lista o que está em atendimento. is_read=false lista o que não foi lido. Retorna {items, page, has_more}.",
    inputSchema: {
      type: "object",
      properties: {
        is_in_work: { type: "boolean" },
        is_read: { type: "boolean" },
        contact_id: { type: "integer" },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
    annotations: { title: "Fila de conversas", ...RO },
  },
  {
    name: "kommo_close_talk",
    description: "Fecha uma conversa pelo talk_id. force_close=false dispara o fluxo de encerramento configurado na conta.",
    inputSchema: {
      type: "object",
      properties: {
        talk_id: { type: "integer" },
        force_close: { type: "boolean", default: true },
      },
      required: ["talk_id"],
    },
    annotations: { title: "Fechar conversa", ...WD },
  },
  {
    name: "kommo_unsorted",
    description: "Inbox de leads ainda não aceitos. summary=true devolve o agregado da fila em vez da lista.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["sip", "mail", "forms", "chats"] },
        pipeline_id: { type: "integer" },
        summary: { type: "boolean", default: false },
        limit: { type: "integer", default: 50, maximum: 250 },
        page: { type: "integer", default: 1 },
      },
    },
    annotations: { title: "Inbox", ...RO },
  },
  {
    name: "kommo_unsorted_accept",
    description: "Aceita um item do Inbox e o transforma em lead ativo. user_id e status_id são opcionais.",
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
    description: "Rejeita um item do Inbox pelo uid. A ação é difícil de desfazer: confirme com a pessoa antes.",
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
    description: "Lista elementos de um catálogo (produtos ou serviços). O catalog_id pode ser obtido com kommo_request em GET /catalogs.",
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
    description: "Cria um elemento num catálogo. Use custom_fields_values para os campos desse catálogo, como preço.",
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
    description: "Dispara um Salesbot em um lead. O lead pode receber mensagens reais. Confirme com a pessoa antes de chamar e não use em lote sem autorização explícita. O bot_id aparece na URL da Kommo ao editar o bot.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "integer" },
        entity_id: { type: "integer", description: "Id do lead" },
        entity_type: { type: "integer", default: 2, description: "2 = lead" },
      },
      required: ["bot_id", "entity_id"],
    },
    annotations: { title: "Disparar Salesbot", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "kommo_upload_file",
    description: "Envia um arquivo local para o drive da conta e, se entity_id for informado, anexa ao lead, contato ou empresa. Recusa arquivos de segredo (.env, chaves, diretórios privados).",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Caminho local do arquivo" },
        file_name: { type: "string", description: "Nome no drive. Padrão: nome do arquivo." },
        entity: { type: "string", enum: ["leads", "contacts", "companies"], default: "leads" },
        entity_id: { type: "integer" },
      },
      required: ["file_path"],
    },
    annotations: { title: "Enviar arquivo", ...W },
  },
  {
    name: "kommo_request",
    description: "Chamada autenticada para um endpoint ainda sem tool própria. path é relativo à v4 (exemplo: /catalogs) ou uma URL https do host da conta. GET, POST, PATCH, PUT e DELETE. O token não sai da allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"], default: "GET" },
        path: { type: "string" },
        query: { type: "object" },
        body: { description: "Corpo JSON para POST, PATCH, PUT ou DELETE" },
      },
      required: ["path"],
    },
    annotations: { title: "Chamada genérica à API", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

export const RESOURCES = [
  { uri: "kommo://account", name: "Conta", description: "Fuso, moeda, drive e tipos de tarefa" },
  { uri: "kommo://pipelines", name: "Funis e etapas", description: "Funis com etapas (ids e nomes)" },
  { uri: "kommo://users", name: "Usuários", description: "Usuários com is_active e is_admin" },
  { uri: "kommo://custom-fields/leads", name: "Campos de leads", description: "Campos personalizados de leads" },
  { uri: "kommo://custom-fields/contacts", name: "Campos de contatos", description: "Campos personalizados de contatos" },
  { uri: "kommo://custom-fields/companies", name: "Campos de empresas", description: "Campos personalizados de empresas" },
  { uri: "kommo://loss-reasons", name: "Motivos de perda", description: "Motivos de perda configurados" },
  { uri: "kommo://task-types", name: "Tipos de tarefa", description: "Tipos de tarefa ativos na conta" },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
