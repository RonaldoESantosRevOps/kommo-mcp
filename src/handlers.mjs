// Implementação das tools. Depende de um cliente e de um catálogo injetados.
import { basename, extname, sep } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { chunk, isoInTz, cfByCode, fmtResponsible, summarizeEvents, summarizeLeads, toUnix } from "./format.mjs";
import { TOOL_BY_NAME } from "./tools.mjs";
import {
  LINK_TARGETS,
  assertArgs,
  clampLimit,
  colorHex,
  customFields,
  entityName,
  enumValue,
  leadIds,
  needString,
  optionalString,
  pageNum,
  positiveInt,
  priceValue,
  safeUid,
  scalarBag,
  tagNames,
  webhookDestination,
  webhookSettings,
  idList,
} from "./validate.mjs";

const MIME = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
};

function listShape(d, key, page) {
  return {
    items: d?._embedded?.[key] || [],
    page: d?._page ?? page ?? 1,
    has_more: !!d?._links?.next,
  };
}

function searchQuery(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new Error("query inválida.");
  const s = v.trim();
  if (s.length < 3) throw new Error("query precisa de 3 ou mais caracteres.");
  if (s.length > 200) throw new Error("query inválida.");
  return s;
}

function optionalQuery(v) {
  if (v === undefined || v === null || v === "") return undefined;
  return needString(v, "query", { min: 1, max: 200 });
}

function enforceMode(name, args, config) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new Error(`Tool desconhecida: ${name}`);
  if (!config.readOnly) return;
  if (name === "kommo_request") {
    const method = String(args.method || "GET").trim().toUpperCase();
    if (method !== "GET") {
      throw new Error("KOMMO_READ_ONLY está ativo. kommo_request só pode usar GET.");
    }
    return;
  }
  if (!tool.annotations?.readOnlyHint) {
    throw new Error(`KOMMO_READ_ONLY está ativo. ${name} altera dados da conta.`);
  }
}

async function resolvePipelineForStatus(statusId, pipelineId, catalog) {
  const statusMap = await catalog.getStatusMap();
  if (pipelineId !== undefined && pipelineId !== null && pipelineId !== "") {
    const pid = positiveInt(pipelineId, "pipeline_id");
    const entry = statusMap.get(`${pid}:${statusId}`);
    if (!entry) throw new Error(`status_id ${statusId} não existe no funil ${pid}. Confira com kommo_pipelines.`);
    if (entry.type === 1) {
      throw new Error("Essa etapa é a etapa de entrada (Inbox). A API não filtra /leads por ela. Use kommo_unsorted.");
    }
    return pid;
  }
  const st = statusMap.get(statusId);
  if (!st) throw new Error(`status_id ${statusId} não existe em nenhum funil. Confira com kommo_pipelines.`);
  if (st.ambiguous) {
    throw new Error(`status_id ${statusId} existe em mais de um funil (142 e 143 são universais). Informe também pipeline_id.`);
  }
  if (st.type === 1) {
    throw new Error("Essa etapa é a etapa de entrada (Inbox). A API não filtra /leads por ela. Use kommo_unsorted.");
  }
  return st.pipeline_id;
}

function dateRange(from, to) {
  const range = {};
  if (from) range.from = toUnix(from);
  if (to) range.to = toUnix(to);
  return Object.keys(range).length ? range : undefined;
}

function assertSafeUpload(filePath, maxBytes) {
  const requested = needString(filePath, "file_path", { max: 4096 });
  if (requested.includes("\0")) throw new Error("Caminho de arquivo inválido.");
  let real;
  try {
    real = realpathSync(requested);
  } catch {
    throw new Error("Arquivo não encontrado.");
  }
  const base = basename(real);
  const parts = real.split(sep);
  const sensitiveDir = parts.some((part) => part === ".ssh" || part === ".gnupg" || part === ".aws" || part === ".config");
  const sensitiveName = base === ".env" || base.startsWith(".env.") || base === ".npmrc" || base === ".netrc"
    || base.endsWith(".pem") || base.endsWith(".key") || base === "id_rsa" || base === "id_ed25519";
  if (sensitiveDir || sensitiveName) {
    throw new Error("Recusa de upload: esse caminho pode conter segredo.");
  }
  const info = statSync(real);
  if (!info.isFile()) throw new Error("O caminho não é um arquivo.");
  if (info.size <= 0) throw new Error("Arquivo vazio.");
  if (info.size > maxBytes) throw new Error(`Arquivo excede o limite de ${maxBytes} bytes.`);
  return { real, size: info.size };
}

export function createHandlers(ctx) {
  const { kommo, catalog, config, containsSecret } = ctx;

  return async function handle(name, raw = {}) {
    const a = assertArgs(raw);
    enforceMode(name, a, config);

    switch (name) {
      case "kommo_account":
        return await kommo("GET", "/account");

      case "kommo_pipelines":
        return await catalog.getPipelines();

      case "kommo_users":
        return await catalog.getUsers();

      case "kommo_custom_fields":
        return await catalog.getCustomFields(entityName(a.entity));

      case "kommo_search_leads": {
        const page = pageNum(a.page);
        const query = { with: "contacts,loss_reason", limit: clampLimit(a.limit, 50, 250), page };
        const text = searchQuery(a.query);
        if (text) query.query = text;
        const filter = {};
        if (a.status_id !== undefined) {
          const statusId = positiveInt(a.status_id, "status_id");
          const pid = await resolvePipelineForStatus(statusId, a.pipeline_id, catalog);
          filter.statuses = [{ pipeline_id: pid, status_id: statusId }];
        } else if (a.pipeline_id !== undefined) {
          filter.pipeline_id = positiveInt(a.pipeline_id, "pipeline_id");
        }
        if (a.responsible_user_id !== undefined) filter.responsible_user_id = positiveInt(a.responsible_user_id, "responsible_user_id");
        const created = dateRange(a.created_from, a.created_to);
        const updated = dateRange(a.updated_from, a.updated_to);
        if (created) filter.created_at = created;
        if (updated) filter.updated_at = updated;
        if (Object.keys(filter).length) query.filter = filter;
        if (a.order_by) {
          const orderBy = enumValue(a.order_by, "order_by", ["created_at", "updated_at", "id"]);
          const orderDir = enumValue(a.order_dir, "order_dir", ["asc", "desc"], "desc");
          query.order = { [orderBy]: orderDir };
        }
        const d = await kommo("GET", "/leads", { query });
        const shape = listShape(d, "leads", page);
        if (!a.raw) {
          const fields = Array.isArray(a.fields) && a.fields.length ? idOrNameList(a.fields) : undefined;
          shape.items = await summarizeLeads(shape.items, fields, { kommo, ...catalog });
        }
        return shape;
      }

      case "kommo_get_lead": {
        const id = positiveInt(a.lead_id, "lead_id");
        const lead = await kommo("GET", `/leads/${id}`, {
          query: { with: "contacts,catalog_elements,loss_reason,source_id" },
        });
        if (lead && a.note_limit) {
          const noteLimit = clampLimit(a.note_limit, 0, 50);
          if (noteLimit > 0) {
            const notes = await kommo("GET", `/leads/${id}/notes`, {
              query: { limit: noteLimit, order: { created_at: "desc" } },
            });
            lead._notes = notes?._embedded?.notes || [];
          }
        }
        return lead;
      }

      case "kommo_create_lead": {
        const base = { name: needString(a.name, "name", { max: 255 }) };
        if (a.price !== undefined) base.price = priceValue(a.price);
        if (a.status_id !== undefined) {
          const statusId = positiveInt(a.status_id, "status_id");
          base.status_id = statusId;
          base.pipeline_id = await resolvePipelineForStatus(statusId, a.pipeline_id, catalog);
        } else if (a.pipeline_id !== undefined) {
          base.pipeline_id = positiveInt(a.pipeline_id, "pipeline_id");
        }
        if (a.responsible_user_id !== undefined) base.responsible_user_id = positiveInt(a.responsible_user_id, "responsible_user_id");
        const cf = customFields(a.custom_fields_values);
        if (cf) base.custom_fields_values = cf;
        if (a.tags?.length) base._embedded = { tags: tagNames(a.tags).map((t) => ({ name: t })) };
        const contactName = optionalString(a.contact_name, "contact_name", { max: 255 });
        const contactPhone = optionalString(a.contact_phone, "contact_phone", { max: 40 });
        if (contactName || contactPhone) {
          const contact = { first_name: contactName || base.name };
          if (contactPhone) {
            contact.custom_fields_values = [
              { field_code: "PHONE", values: [{ value: contactPhone, enum_code: "WORK" }] },
            ];
          }
          base._embedded = { ...(base._embedded || {}), contacts: [contact] };
          return await kommo("POST", "/leads/complex", { body: [base] });
        }
        return await kommo("POST", "/leads", { body: [base] });
      }

      case "kommo_update_lead": {
        const id = positiveInt(a.lead_id, "lead_id");
        const body = { id };
        if (a.name !== undefined) body.name = needString(a.name, "name", { max: 255 });
        if (a.price !== undefined) body.price = priceValue(a.price);
        if (a.status_id !== undefined) {
          const statusId = positiveInt(a.status_id, "status_id");
          body.status_id = statusId;
          body.pipeline_id = await resolvePipelineForStatus(statusId, a.pipeline_id, catalog);
        } else if (a.pipeline_id !== undefined) {
          body.pipeline_id = positiveInt(a.pipeline_id, "pipeline_id");
        }
        if (a.responsible_user_id !== undefined) body.responsible_user_id = positiveInt(a.responsible_user_id, "responsible_user_id");
        if (a.loss_reason_id !== undefined) body.loss_reason_id = positiveInt(a.loss_reason_id, "loss_reason_id");
        const cf = customFields(a.custom_fields_values);
        if (cf) body.custom_fields_values = cf;
        if (a.tags_to_add?.length) body.tags_to_add = tagNames(a.tags_to_add).map((t) => ({ name: t }));
        if (a.tags_to_remove?.length) body.tags_to_delete = tagNames(a.tags_to_remove).map((t) => ({ name: t }));
        if (Object.keys(body).length === 1) throw new Error("Nada para atualizar.");
        return await kommo("PATCH", `/leads/${id}`, { body });
      }

      case "kommo_change_responsible": {
        const ids = leadIds(a.lead_ids);
        const rid = positiveInt(a.responsible_user_id, "responsible_user_id");
        return patchLeadChunks(kommo, ids, () => ({ responsible_user_id: rid }));
      }

      case "kommo_bulk_update_leads": {
        const ids = leadIds(a.lead_ids);
        const patch = {};
        if (a.status_id !== undefined) {
          const statusId = positiveInt(a.status_id, "status_id");
          patch.status_id = statusId;
          patch.pipeline_id = await resolvePipelineForStatus(statusId, a.pipeline_id, catalog);
        } else if (a.pipeline_id !== undefined) {
          patch.pipeline_id = positiveInt(a.pipeline_id, "pipeline_id");
        }
        if (a.responsible_user_id !== undefined) patch.responsible_user_id = positiveInt(a.responsible_user_id, "responsible_user_id");
        if (a.price !== undefined) patch.price = priceValue(a.price);
        if (a.loss_reason_id !== undefined) patch.loss_reason_id = positiveInt(a.loss_reason_id, "loss_reason_id");
        const tags = a.tags_to_add?.length ? tagNames(a.tags_to_add).map((t) => ({ name: t })) : undefined;
        if (!Object.keys(patch).length && !tags) {
          throw new Error("Nada para atualizar: informe status_id, pipeline_id, responsible_user_id, price, loss_reason_id ou tags_to_add.");
        }
        return patchLeadChunks(kommo, ids, () => ({ ...patch, ...(tags ? { tags_to_add: tags } : {}) }));
      }

      case "kommo_add_note": {
        const entity = entityName(a.entity);
        const noteType = enumValue(a.note_type, "note_type", ["common", "call_in", "call_out"], "common");
        const params = { text: needString(a.text, "text", { max: 20_000 }), ...(scalarBag(a.params_extra, "params_extra") || {}) };
        return await kommo("POST", `/${entity}/${positiveInt(a.entity_id, "entity_id")}/notes`, {
          body: [{ note_type: noteType, params }],
        });
      }

      case "kommo_create_task": {
        const entity = entityName(a.entity);
        const task = {
          text: needString(a.text, "text", { max: 4000 }),
          complete_till: a.complete_till ? toUnix(a.complete_till) : Math.floor(Date.now() / 1000) + 86400,
          entity_type: entity,
        };
        if (a.entity_id !== undefined) task.entity_id = positiveInt(a.entity_id, "entity_id");
        if (a.responsible_user_id !== undefined) task.responsible_user_id = positiveInt(a.responsible_user_id, "responsible_user_id");
        if (a.task_type_id !== undefined) task.task_type_id = positiveInt(a.task_type_id, "task_type_id");
        return await kommo("POST", "/tasks", { body: [task] });
      }

      case "kommo_complete_task": {
        const body = { is_completed: true };
        const result = optionalString(a.result, "result", { max: 4000 });
        if (result) body.result = { text: result };
        return await kommo("PATCH", `/tasks/${positiveInt(a.task_id, "task_id")}`, { body });
      }

      case "kommo_list_tasks": {
        const page = pageNum(a.page);
        const query = { limit: clampLimit(a.limit, 50, 250), page };
        const filter = {};
        if (a.responsible_user_id !== undefined) filter.responsible_user_id = positiveInt(a.responsible_user_id, "responsible_user_id");
        if (a.entity_id !== undefined) filter.entity_id = positiveInt(a.entity_id, "entity_id");
        if (a.entity_type) filter.entity_type = entityName(a.entity_type, null);
        if (a.is_completed !== undefined) {
          if (typeof a.is_completed !== "boolean") throw new Error("is_completed deve ser booleano.");
          filter.is_completed = a.is_completed ? 1 : 0;
        }
        if (Object.keys(filter).length) query.filter = filter;
        const d = await kommo("GET", "/tasks", { query });
        const shape = listShape(d, "tasks", page);
        const [userMap, acc] = await Promise.all([catalog.getUserMap(), catalog.getAccountInfo()]);
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
        const page = pageNum(a.page);
        const query = { limit: clampLimit(a.limit, 100, 100), page, with: "contact_name,lead_name" };
        const filter = {};
        if (a.entity) filter.entity = enumValue(a.entity, "entity", ["lead", "contact", "company", "task"]);
        if (a.entity_id !== undefined) filter.entity_id = [positiveInt(a.entity_id, "entity_id")];
        if (a.type) {
          if (!Array.isArray(a.type) || a.type.length > 20) throw new Error("type inválido.");
          filter.type = a.type.map((item, i) => needString(item, `type[${i}]`, { max: 64 }));
        }
        if (a.created_by) filter.created_by = idList(a.created_by, "created_by", { allowZero: true, max: 50 });
        const created = dateRange(a.from, a.to);
        if (created) filter.created_at = created;
        if (Object.keys(filter).length) query.filter = filter;
        const d = await kommo("GET", "/events", { query });
        const shape = listShape(d, "events", page);
        if (!a.raw) shape.items = await summarizeEvents(shape.items, catalog);
        return shape;
      }

      case "kommo_search_contacts":
        return searchPeople(kommo, catalog, a, "contacts", (c, userMap, tz) => ({
          id: c.id,
          name: c.name,
          phone: cfByCode(c, "PHONE"),
          email: cfByCode(c, "EMAIL"),
          responsible: fmtResponsible(userMap, c.responsible_user_id),
          created_at: isoInTz(c.created_at, tz),
          lead_ids: (c._embedded?.leads || []).map((l) => l.id),
        }), "leads");

      case "kommo_search_companies":
        return searchPeople(kommo, catalog, a, "companies", (c, userMap, tz) => ({
          id: c.id,
          name: c.name,
          phone: cfByCode(c, "PHONE"),
          responsible: fmtResponsible(userMap, c.responsible_user_id),
          created_at: isoInTz(c.created_at, tz),
        }));

      case "kommo_create_status": {
        const status = { name: needString(a.name, "name", { max: 255 }) };
        if (a.sort !== undefined) status.sort = positiveInt(a.sort, "sort", { allowZero: true });
        const color = colorHex(a.color);
        if (color) status.color = color;
        const created = await kommo("POST", `/leads/pipelines/${positiveInt(a.pipeline_id, "pipeline_id")}/statuses`, { body: [status] });
        catalog.invalidateCache("pipelines");
        return created;
      }

      case "kommo_update_status": {
        const body = {};
        if (a.name !== undefined) body.name = needString(a.name, "name", { max: 255 });
        if (a.sort !== undefined) body.sort = positiveInt(a.sort, "sort", { allowZero: true });
        const color = colorHex(a.color);
        if (color) body.color = color;
        if (!Object.keys(body).length) throw new Error("Nada para atualizar.");
        const updated = await kommo(
          "PATCH",
          `/leads/pipelines/${positiveInt(a.pipeline_id, "pipeline_id")}/statuses/${positiveInt(a.status_id, "status_id")}`,
          { body },
        );
        catalog.invalidateCache("pipelines");
        return updated;
      }

      case "kommo_create_contact":
        return await kommo("POST", "/contacts", { body: [contactBody(a, false)] });

      case "kommo_update_contact": {
        const id = positiveInt(a.contact_id, "contact_id");
        const body = contactBody(a, true);
        body.id = id;
        if (Object.keys(body).length === 1) throw new Error("Nada para atualizar.");
        return await kommo("PATCH", `/contacts/${id}`, { body });
      }

      case "kommo_create_company": {
        const company = { name: needString(a.name, "name", { max: 255 }) };
        if (a.responsible_user_id !== undefined) company.responsible_user_id = positiveInt(a.responsible_user_id, "responsible_user_id");
        const cf = customFields(a.custom_fields_values);
        if (cf) company.custom_fields_values = cf;
        return await kommo("POST", "/companies", { body: [company] });
      }

      case "kommo_update_company": {
        const id = positiveInt(a.company_id, "company_id");
        const body = { id };
        if (a.name !== undefined) body.name = needString(a.name, "name", { max: 255 });
        if (a.responsible_user_id !== undefined) body.responsible_user_id = positiveInt(a.responsible_user_id, "responsible_user_id");
        const cf = customFields(a.custom_fields_values);
        if (cf) body.custom_fields_values = cf;
        if (Object.keys(body).length === 1) throw new Error("Nada para atualizar.");
        return await kommo("PATCH", `/companies/${id}`, { body });
      }

      case "kommo_link": {
        const target = a.to_entity_type;
        if (!LINK_TARGETS.has(target)) throw new Error("to_entity_type inválido.");
        const link = {
          to_entity_id: positiveInt(a.to_entity_id, "to_entity_id"),
          to_entity_type: target,
        };
        if (target === "catalog_elements") {
          const quantity = a.quantity === undefined ? 1 : positiveInt(a.quantity, "quantity");
          link.metadata = { catalog_id: positiveInt(a.catalog_id, "catalog_id"), quantity };
        }
        return await kommo("POST", `/${entityName(a.entity, null)}/${positiveInt(a.entity_id, "entity_id")}/link`, { body: [link] });
      }

      case "kommo_list_webhooks": {
        const d = await kommo("GET", "/webhooks");
        return d?._embedded?.webhooks || [];
      }

      case "kommo_subscribe_webhook":
        return await kommo("POST", "/webhooks", {
          body: {
            destination: webhookDestination(a.destination, { requireHttps: true, apiHost: config.apiHost, blockApiHost: true }),
            settings: webhookSettings(a.settings),
          },
        });

      case "kommo_delete_webhook":
        return await kommo("DELETE", "/webhooks", {
          body: {
            destination: webhookDestination(a.destination, { requireHttps: false, apiHost: config.apiHost, blockApiHost: false }),
          },
        });

      case "kommo_create_custom_field": {
        const entity = entityName(a.entity);
        const field = {
          name: needString(a.name, "name", { max: 255 }),
          type: fieldType(a.type),
        };
        if (a.enums?.length) field.enums = tagNames(a.enums).map((value, i) => ({ value, sort: (i + 1) * 10 }));
        const created = await kommo("POST", `/${entity}/custom_fields`, { body: [field] });
        catalog.invalidateCache(`cf:${entity}`);
        return created;
      }

      case "kommo_update_custom_field": {
        const entity = entityName(a.entity);
        const fieldId = positiveInt(a.field_id, "field_id");
        const body = {};
        if (a.name !== undefined) body.name = needString(a.name, "name", { max: 255 });
        if (a.add_enums?.length) {
          const additions = tagNames(a.add_enums);
          const cur = await kommo("GET", `/${entity}/custom_fields/${fieldId}`);
          if (!["select", "multiselect", "radiobutton"].includes(cur.type)) {
            throw new Error(`Campo do tipo ${cur.type} não aceita enums.`);
          }
          const existing = (cur.enums || []).map((e) => ({ id: e.id, value: e.value, sort: e.sort }));
          const known = new Set(existing.map((e) => String(e.value).toLowerCase()));
          let maxSort = Math.max(0, ...existing.map((e) => e.sort || 0));
          body.enums = [...existing];
          for (const value of additions) {
            if (!known.has(value.toLowerCase())) body.enums.push({ value, sort: (maxSort += 10) });
          }
        }
        if (!Object.keys(body).length) throw new Error("Nada para atualizar: informe name e/ou add_enums.");
        const updated = await kommo("PATCH", `/${entity}/custom_fields/${fieldId}`, { body });
        catalog.invalidateCache(`cf:${entity}`);
        return updated;
      }

      case "kommo_tags": {
        const entity = entityName(a.entity);
        const page = pageNum(a.page);
        const query = { limit: clampLimit(a.limit, 100, 250), page };
        const text = optionalQuery(a.query);
        if (text) query.query = text;
        const d = await kommo("GET", `/${entity}/tags`, { query });
        const shape = listShape(d, "tags", page);
        shape.items = shape.items.map((t) => ({ id: t.id, name: t.name, color: t.color || undefined }));
        return shape;
      }

      case "kommo_loss_reasons":
        return await catalog.getLossReasons();

      case "kommo_talks": {
        const page = pageNum(a.page);
        const query = { limit: clampLimit(a.limit, 50, 250), page };
        const filter = {};
        if (a.is_in_work !== undefined) {
          if (typeof a.is_in_work !== "boolean") throw new Error("is_in_work deve ser booleano.");
          filter.is_in_work = a.is_in_work ? 1 : 0;
        }
        if (a.is_read !== undefined) {
          if (typeof a.is_read !== "boolean") throw new Error("is_read deve ser booleano.");
          filter.is_read = a.is_read ? 1 : 0;
        }
        if (a.contact_id !== undefined) filter.contact_id = positiveInt(a.contact_id, "contact_id");
        if (Object.keys(filter).length) query.filter = filter;
        const d = await kommo("GET", "/talks", { query });
        const shape = listShape(d, "talks", page);
        if (d?._total_items !== undefined) shape.total = d._total_items;
        const acc = await catalog.getAccountInfo();
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
        const talkId = positiveInt(a.talk_id, "talk_id");
        if (a.force_close !== undefined && typeof a.force_close !== "boolean") {
          throw new Error("force_close deve ser booleano.");
        }
        await kommo("POST", `/talks/${talkId}/close`, { body: { force_close: a.force_close ?? true } });
        return { ok: true, talk_id: talkId };
      }

      case "kommo_unsorted": {
        const page = pageNum(a.page);
        if (a.summary === true) return await kommo("GET", "/leads/unsorted/summary");
        if (a.summary !== undefined && a.summary !== false) throw new Error("summary deve ser booleano.");
        const query = { limit: clampLimit(a.limit, 50, 250), page };
        const filter = {};
        if (a.category) filter.category = [enumValue(a.category, "category", ["sip", "mail", "forms", "chats"])];
        if (a.pipeline_id !== undefined) filter.pipeline_id = [positiveInt(a.pipeline_id, "pipeline_id")];
        if (Object.keys(filter).length) query.filter = filter;
        const d = await kommo("GET", "/leads/unsorted", { query });
        const shape = listShape(d, "unsorted", page);
        const [pipes, acc] = await Promise.all([catalog.getPipelines(), catalog.getAccountInfo()]);
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
        if (a.user_id !== undefined) body.user_id = positiveInt(a.user_id, "user_id");
        if (a.status_id !== undefined) body.status_id = positiveInt(a.status_id, "status_id");
        return await kommo("POST", `/leads/unsorted/${encodeURIComponent(safeUid(a.uid))}/accept`, { body });
      }

      case "kommo_unsorted_decline": {
        const body = {};
        if (a.user_id !== undefined) body.user_id = positiveInt(a.user_id, "user_id");
        return await kommo("DELETE", `/leads/unsorted/${encodeURIComponent(safeUid(a.uid))}/decline`, { body });
      }

      case "kommo_catalog_elements": {
        const page = pageNum(a.page);
        const catalogId = positiveInt(a.catalog_id, "catalog_id");
        const query = { limit: clampLimit(a.limit, 50, 250), page };
        const text = optionalQuery(a.query);
        if (text) query.query = text;
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
        const el = { name: needString(a.name, "name", { max: 255 }) };
        const cf = customFields(a.custom_fields_values);
        if (cf) el.custom_fields_values = cf;
        return await kommo("POST", `/catalogs/${positiveInt(a.catalog_id, "catalog_id")}/elements`, { body: [el] });
      }

      case "kommo_run_salesbot":
        return await kommo("POST", `https://${config.apiHost}/api/v2/salesbot/run`, {
          body: [{
            bot_id: positiveInt(a.bot_id, "bot_id"),
            entity_id: positiveInt(a.entity_id, "entity_id"),
            entity_type: a.entity_type === undefined ? 2 : positiveInt(a.entity_type, "entity_type"),
          }],
        });

      case "kommo_upload_file": {
        const { real, size } = assertSafeUpload(a.file_path, config.uploadMaxBytes);
        const buf = readFileSync(real);
        if (buf.length > config.uploadMaxBytes) throw new Error(`Arquivo excede o limite de ${config.uploadMaxBytes} bytes.`);
        if (containsSecret(buf)) throw new Error("Recusa de upload: o arquivo contém segredo de configuração.");
        const fileName = a.file_name ? needString(a.file_name, "file_name", { max: 200 }) : basename(real);
        const acc = await catalog.getAccountInfo();
        if (!acc.drive_url) throw new Error("A conta não tem drive configurado.");
        const session = await kommo("POST", `${acc.drive_url.replace(/\/$/, "")}/v1.0/sessions`, {
          body: {
            file_name: fileName,
            file_size: size,
            content_type: MIME[extname(fileName).toLowerCase()] || "application/octet-stream",
          },
        });
        let uploadUrl = session.upload_url;
        const partSize = Number.isInteger(session.max_part_size) && session.max_part_size > 0 ? session.max_part_size : buf.length;
        let fileInfo = null;
        const maxParts = Math.ceil(buf.length / partSize) + 1;
        let parts = 0;
        for (let off = 0; off < buf.length; off += partSize) {
          if (++parts > maxParts) throw new Error("Upload não terminou.");
          const part = buf.subarray(off, Math.min(off + partSize, buf.length));
          const uploaded = await kommo("POST", uploadUrl, {
            body: part,
            headers: { "Content-Type": "application/octet-stream" },
            timeoutMs: 120_000,
          });
          if (uploaded?.next_url) uploadUrl = uploaded.next_url;
          else fileInfo = uploaded;
        }
        if (!fileInfo?.uuid) throw new Error("Upload terminou sem o identificador do arquivo.");
        const out = { file: { uuid: fileInfo.uuid, name: fileInfo.name || fileName, size: buf.length } };
        if (a.entity_id !== undefined) {
          const entity = entityName(a.entity);
          const entityId = positiveInt(a.entity_id, "entity_id");
          await kommo("PUT", `/${entity}/${entityId}/files`, { body: [{ file_uuid: fileInfo.uuid }] });
          out.attached_to = `${entity}#${entityId}`;
        }
        return out;
      }

      case "kommo_request": {
        const method = enumValue(String(a.method || "GET").trim().toUpperCase(), "method", ["GET", "POST", "PATCH", "PUT", "DELETE"]);
        if (a.query !== undefined && (!a.query || typeof a.query !== "object" || Array.isArray(a.query))) {
          throw new Error("query deve ser um objeto.");
        }
        return await kommo(method, needString(a.path, "path", { max: 2000 }), { query: a.query, body: a.body });
      }

      default:
        throw new Error(`Tool desconhecida: ${name}`);
    }
  };
}

function idOrNameList(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > 20) throw new Error("fields inválido.");
  return v.map((item, i) => {
    if (typeof item === "number") return positiveInt(item, `fields[${i}]`);
    if (typeof item === "string" && /^\d+$/.test(item)) return positiveInt(item, `fields[${i}]`);
    return needString(item, `fields[${i}]`, { max: 120 });
  });
}

async function patchLeadChunks(kommo, ids, build) {
  const result = { updated: 0, failed: [], chunks: 0 };
  for (const part of chunk(ids, 200)) {
    result.chunks++;
    try {
      const d = await kommo("PATCH", "/leads", { body: part.map((id) => ({ id, ...build() })) });
      result.updated += d?._embedded?.leads?.length ?? part.length;
    } catch (err) {
      result.failed.push({ lead_ids: part, error: err.message });
    }
  }
  return result;
}

async function searchPeople(kommo, catalog, a, key, mapItem, withValue) {
  const page = pageNum(a.page);
  const query = { limit: clampLimit(a.limit, 50, 250), page };
  if (withValue) query.with = withValue;
  const text = searchQuery(a.query);
  if (text) query.query = text;
  const d = await kommo("GET", `/${key}`, { query });
  const shape = listShape(d, key, page);
  if (!a.raw) {
    const [userMap, acc] = await Promise.all([catalog.getUserMap(), catalog.getAccountInfo()]);
    shape.items = shape.items.map((item) => mapItem(item, userMap, acc.timezone));
  }
  return shape;
}

function fieldType(v) {
  const type = v === undefined || v === null || v === "" ? "text" : v;
  if (typeof type !== "string" || !/^[a-z0-9_]{1,40}$/.test(type)) throw new Error("type inválido.");
  return type;
}

function contactBody(a, partial) {
  const body = {};
  if (a.name !== undefined) body.name = needString(a.name, "name", { max: 255 });
  if (a.first_name !== undefined) body.first_name = needString(a.first_name, "first_name", { max: 255 });
  if (a.last_name !== undefined) body.last_name = needString(a.last_name, "last_name", { max: 255 });
  if (a.responsible_user_id !== undefined) body.responsible_user_id = positiveInt(a.responsible_user_id, "responsible_user_id");
  const cfv = [];
  const phone = optionalString(a.phone, "phone", { max: 40 });
  const email = optionalString(a.email, "email", { max: 200 });
  if (phone) cfv.push({ field_code: "PHONE", values: [{ value: phone, enum_code: "WORK" }] });
  if (email) cfv.push({ field_code: "EMAIL", values: [{ value: email, enum_code: "WORK" }] });
  const extra = customFields(a.custom_fields_values);
  if (extra) cfv.push(...extra);
  if (cfv.length) body.custom_fields_values = cfv;
  if (!partial && !body.name && !body.first_name && !body.last_name && !cfv.length && body.responsible_user_id === undefined) {
    throw new Error("Informe ao menos um dado do contato.");
  }
  return body;
}

export async function readResource(uri, catalog) {
  switch (uri) {
    case "kommo://account": return catalog.getAccountInfo();
    case "kommo://pipelines": return catalog.getPipelines();
    case "kommo://users": return catalog.getUsers();
    case "kommo://custom-fields/leads": return catalog.getCustomFields("leads");
    case "kommo://custom-fields/contacts": return catalog.getCustomFields("contacts");
    case "kommo://custom-fields/companies": return catalog.getCustomFields("companies");
    case "kommo://loss-reasons": return catalog.getLossReasons();
    case "kommo://task-types": return (await catalog.getAccountInfo()).task_types;
    default: throw new Error(`Resource desconhecido: ${uri}`);
  }
}
