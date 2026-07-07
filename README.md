# kommo-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-server-6E56CF)](https://modelcontextprotocol.io)

Servidor [**MCP** (Model Context Protocol)](https://modelcontextprotocol.io) self-hosted para a
**[Kommo CRM](https://www.kommo.com)** (antiga amoCRM, API v4).

Conecta o **Claude** — ou qualquer cliente MCP (Claude Code, Claude Desktop, Cursor, etc.) —
direto na sua conta Kommo, usando um **token de longa duração** seu. Sem intermediários: as
credenciais e os dados trafegam apenas entre a sua máquina/servidor e a API da Kommo.

Com ele, o assistente passa a **agir no CRM em tempo real** (criar/mover leads, escrever
tarefas, trocar responsáveis, auditar o que os bots fizeram) em vez de depender só de
dashboards e planilhas.

---

## Sumário

- [Recursos](#recursos)
- [Pré-requisitos](#pré-requisitos)
- [Instalação](#instalação)
- [1. Gerar o token da Kommo](#1-gerar-o-token-da-kommo)
- [2. Configurar o `.env`](#2-configurar-o-env)
- [3. Testar a conexão](#3-testar-a-conexão)
- [Usar no Claude Code](#usar-no-claude-code)
- [Usar em outros clientes MCP](#usar-em-outros-clientes-mcp)
- [Referência das tools](#referência-das-tools)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Segurança](#segurança)
- [Limitações conhecidas](#limitações-conhecidas)
- [Troubleshooting](#troubleshooting)
- [Deploy em servidor (VPS)](#deploy-em-servidor-vps)
- [Licença](#licença)

---

## Recursos

**41 tools**, **4 prompts** e **8 resources** MCP:

| Categoria | Tools |
|---|---|
| **Leitura** | `kommo_account`, `kommo_pipelines`, `kommo_users` (com `is_active`), `kommo_custom_fields`, `kommo_search_leads`, `kommo_get_lead`, `kommo_list_tasks`, `kommo_search_contacts`, `kommo_search_companies`, `kommo_list_webhooks`, `kommo_tags`, `kommo_loss_reasons`, `kommo_catalog_elements` |
| **Auditoria** | `kommo_get_events` (feed traduzido: etapas/autores por nome; `created_by=0` = bot/automação) |
| **Atendimento** | `kommo_talks` (fila de conversas em tempo real), `kommo_close_talk`, `kommo_unsorted` (Inbox), `kommo_unsorted_accept`, `kommo_unsorted_decline` |
| **Leads** | `kommo_create_lead`, `kommo_update_lead` (com tags), `kommo_change_responsible`, `kommo_bulk_update_leads` (lote com fatiamento) |
| **Tarefas & notas** | `kommo_create_task` (tipos reais da conta na descrição), `kommo_complete_task`, `kommo_add_note` (common/call_in/call_out) |
| **Contatos & empresas** | `kommo_create_contact`, `kommo_update_contact`, `kommo_create_company`, `kommo_update_company`, `kommo_link` (inclui catalog_elements) |
| **Funis/etapas** | `kommo_create_status`, `kommo_update_status` |
| **Webhooks** | `kommo_subscribe_webhook`, `kommo_delete_webhook` |
| **Campos custom** | `kommo_create_custom_field`, `kommo_update_custom_field` (com `add_enums`) |
| **Catálogo & arquivos** | `kommo_create_catalog_element`, `kommo_upload_file` |
| **Automação** | `kommo_run_salesbot` (dispara bot num lead; sempre confirme antes) |
| **Genérico** | `kommo_request` (passthrough autenticado, restrito a hosts `*.kommo.com` da conta) |

**Formato de resposta:** listagens devolvem `{ items, page, has_more }` com itens **resumidos e legíveis**
(funil/etapa/responsável por nome, telefone do contato principal, datas no fuso da conta); `raw: true`
devolve o payload cru da API. Todas as tools declaram MCP annotations (`readOnlyHint`/`destructiveHint`),
então clientes conseguem liberar leituras e travar escritas por protocolo.

**Prompts** (viram comandos no cliente MCP): `auditoria-do-dia`, `fila-agora`, `leads-parados`, `relatorio-perdas`.
**Resources**: `kommo://account`, `kommo://pipelines`, `kommo://users`, `kommo://custom-fields/{leads,contacts,companies}`, `kommo://loss-reasons`, `kommo://task-types`.

---

## Pré-requisitos

- **Node.js ≥ 18** (usa `fetch` nativo; sem dependências de runtime além do SDK do MCP).
- Uma conta **Kommo** com permissão de **administrador** (necessária para gerar o token).
- Um cliente MCP — este README foca no **[Claude Code](https://docs.claude.com/claude-code)**.

---

## Instalação

```bash
git clone https://github.com/RonaldoESantosRevOps/kommo-mcp.git
cd kommo-mcp
npm install
```

---

## 1. Gerar o token da Kommo

Use um **token de longa duração** (não expira por anos e não precisa de refresh):

1. Na Kommo, vá em **Configurações → Integrações**.
2. Clique para criar uma **integração privada** (não precisa preencher Redirect URL nem webhook).
3. Abra a aba **Chaves e escopos**.
4. Clique em **Gerar token de longa duração**, escolha a validade (até 5 anos) e **copie o token**.
5. O escopo **`crm`** já é suficiente para todas as tools.

Guarde o token com cuidado — ele dá acesso total ao seu CRM com os seus direitos de admin.

> Documentação oficial: <https://pt-developers.kommo.com/docs/token-de-longa-duração>

---

## 2. Configurar o `.env`

Copie o exemplo e preencha:

```bash
cp .env.example .env
```

```env
KOMMO_SUBDOMAIN=seusubdominio        # a parte antes de .kommo.com (ex.: "minhaempresa")
KOMMO_TOKEN=seu_token_de_longa_duracao
```

O `.env` já está no `.gitignore` — **nunca** o versione. O servidor lê esse arquivo
automaticamente (ele fica ao lado do `index.mjs`), então você não precisa exportar variáveis
de ambiente manualmente.

---

## 3. Testar a conexão

```bash
npm run smoke
```

Esse smoke test sobe o servidor via protocolo MCP e chama tools de leitura contra a **API real**.
Saída esperada (resumida):

```
✓ tools expostas: 41
✓ annotations ok (16 tools read-only)
✓ allowlist bloqueia host externo no passthrough
✓ kommo_account -> <Nome da sua conta> (id ..., BRL)
✓ kommo_pipelines -> N funis; principal: ...
✓ kommo_users -> N usuários (M inativos: ...)
✓ kommo_search_leads -> resumo ok; ...
✓ kommo_get_events -> 5 eventos traduzidos (autor, etapas por nome, ISO)
✓ kommo_talks / kommo_unsorted / kommo_tags / kommo_loss_reasons ...
✓ SMOKE OK
```

O teste de escrita opcional (`node smoke.mjs --write`) faz um round-trip inofensivo de webhook
(assina, confere e remove), sem tocar em leads ou contatos.

Se aparecer `HTTP 401 Invalid user name or password`, veja [Troubleshooting](#troubleshooting).

---

## Usar no Claude Code

### Registrar o servidor

```bash
claude mcp add kommo -s user -- node /caminho/absoluto/para/kommo-mcp/index.mjs
```

- Use o **caminho absoluto** até o `index.mjs` (ex.: `~/kommo-mcp/index.mjs` resolvido para algo
  como `/home/voce/kommo-mcp/index.mjs`).
- O servidor lê o `.env` dele mesmo, então **não** é preciso passar variáveis no comando.

**Escopos** (`-s`):

| Escopo | Onde vale | Quando usar |
|---|---|---|
| `user` | Todos os seus projetos | Recomendado — você usa a mesma conta Kommo em qualquer lugar |
| `project` | Compartilhado no repositório (`.mcp.json`) | Se um time inteiro vai usar |
| `local` | Só você, só neste projeto | Testes pontuais |

### Verificar

```bash
claude mcp get kommo     # deve mostrar "Status: ✔ Connected"
claude mcp list          # lista todos os servidores MCP
```

> **Reinicie o Claude Code** depois de registrar: as tools de um servidor MCP só entram quando a
> sessão inicia.

### Permissões: leitura sem prompt, escrita sempre confirmando

Por padrão o Claude Code pede confirmação a cada chamada de tool. Você pode liberar **apenas as
tools de leitura** (consultas) e manter as de escrita sempre pedindo OK. No seu
`~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__kommo__kommo_account",
      "mcp__kommo__kommo_pipelines",
      "mcp__kommo__kommo_users",
      "mcp__kommo__kommo_custom_fields",
      "mcp__kommo__kommo_search_leads",
      "mcp__kommo__kommo_get_lead",
      "mcp__kommo__kommo_list_tasks",
      "mcp__kommo__kommo_search_contacts",
      "mcp__kommo__kommo_search_companies",
      "mcp__kommo__kommo_list_webhooks",
      "mcp__kommo__kommo_get_events",
      "mcp__kommo__kommo_tags",
      "mcp__kommo__kommo_loss_reasons",
      "mcp__kommo__kommo_talks",
      "mcp__kommo__kommo_unsorted",
      "mcp__kommo__kommo_catalog_elements"
    ]
  }
}
```

Todas as tools de escrita (criar/editar leads, contatos, empresas, tarefas, notas, etapas,
campos custom, vínculos, webhooks, lotes, Inbox accept/decline, Salesbot e upload) e o
passthrough `kommo_request` **continuam pedindo confirmação** — o comportamento seguro
recomendado. As 16 tools de leitura também declaram `readOnlyHint: true` via MCP annotations,
então clientes que respeitam annotations já as tratam como seguras.

### Exemplos de uso (linguagem natural)

Depois de registrado, é só pedir ao Claude:

- *"Liste os leads parados na etapa 'Interesse em Agendar' do funil principal."*
- *"O que os bots fizeram hoje? Puxe os eventos com `created_by=0` das últimas 6 horas."*
- *"Crie um lead 'João da Silva', telefone +55 11 99999-9999, no funil de qualificação."*
- *"Mova o lead #12345 para 'Pagamento' e troque o responsável para a Ana."*
- *"Crie uma tarefa de follow-up amanhã às 10h no lead #12345 para o Carlos."*

---

## Usar em outros clientes MCP

O servidor fala MCP por **stdio**, então funciona em qualquer cliente compatível. Exemplo de
configuração genérica (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "kommo": {
      "command": "node",
      "args": ["/caminho/absoluto/para/kommo-mcp/index.mjs"]
    }
  }
}
```

Como o `.env` é lido a partir da pasta do servidor, não é necessário passar `env` no JSON
(mas você pode, se preferir injetar `KOMMO_SUBDOMAIN`/`KOMMO_TOKEN` por ali).

---

## Referência das tools

> Datas aceitam ISO (`2026-06-26T10:00`) ou epoch. IDs de funil/etapa/usuário você descobre com
> `kommo_pipelines` e `kommo_users`. Listagens devolvem `{ items, page, has_more }`; onde houver
> `raw`, `raw: true` devolve o payload cru da API.

### Leitura

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_account` | — | Dados da conta (confirma a conexão). |
| `kommo_pipelines` | — | Lista funis e suas etapas (`id`, `name`, `sort`, `type`). |
| `kommo_users` | — | Lista usuários com `is_active`/`is_admin` (não atribua a inativos). |
| `kommo_custom_fields` | `entity` (`leads`/`contacts`/`companies`) | Lista campos personalizados e seus `id`. |
| `kommo_search_leads` | `query`, `pipeline_id`, `status_id` (resolve o funil sozinho), `responsible_user_id`, `created_from/to`, `updated_from/to`, `order_by`, `fields[]`, `raw`, `limit`, `page` | Busca leads resumidos (funil/etapa/responsável por nome, telefone, tags, motivo de perda). |
| `kommo_get_lead` | `lead_id`*, `note_limit` | Detalhe cru de um lead (contatos, catálogo, motivo de perda); anexa notas se `note_limit>0`. |
| `kommo_list_tasks` | `responsible_user_id`, `entity_id`, `entity_type`, `is_completed`, `limit`, `page` | Lista tarefas resumidas. |
| `kommo_search_contacts` | `query`, `raw`, `limit`, `page` | Busca contatos (telefone/email extraídos). |
| `kommo_search_companies` | `query`, `raw`, `limit`, `page` | Busca empresas. |
| `kommo_list_webhooks` | — | Lista os webhooks configurados (destino e eventos). |
| `kommo_tags` | `entity`, `query`, `limit`, `page` | Lista tags (id, nome, cor). |
| `kommo_loss_reasons` | — | Lista os motivos de perda configurados. |
| `kommo_catalog_elements` | `catalog_id`*, `query`, `limit`, `page` | Lista elementos de um catálogo (produtos/serviços). |

### Auditoria

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_get_events` | `entity`, `entity_id`, `type[]`, `created_by[]`, `from`, `to`, `raw`, `limit`, `page` | Feed de eventos **traduzido** (etapas e autores por nome, datas no fuso da conta). **`created_by=0` = ações de bot/automação.** |

### Atendimento & Inbox

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_talks` | `is_in_work`, `is_read`, `contact_id`, `limit`, `page` | Fila de conversas (chats) em tempo real. |
| `kommo_close_talk` | `talk_id`*, `force_close` | Fecha uma conversa. |
| `kommo_unsorted` | `category`, `pipeline_id`, `summary`, `limit`, `page` | Inbox de leads não distribuídos (`summary: true` = agregado). |
| `kommo_unsorted_accept` | `uid`*, `user_id`, `status_id` | Aceita um item do Inbox (vira lead ativo). |
| `kommo_unsorted_decline` | `uid`*, `user_id` | Rejeita um item do Inbox (difícil de desfazer). |

### Escrita em leads

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_create_lead` | `name`*, `price`, `pipeline_id`, `status_id`, `responsible_user_id`, `contact_name`, `contact_phone`, `tags[]`, `custom_fields_values` | Cria lead; vincula contato se informado. |
| `kommo_update_lead` | `lead_id`*, `name`, `price`, `status_id`, `pipeline_id`, `responsible_user_id`, `loss_reason_id`, `tags_to_add[]`, `tags_to_remove[]`, `custom_fields_values` | Atualiza lead; tags são mescladas preservando as existentes. |
| `kommo_change_responsible` | `lead_ids[]`*, `responsible_user_id`* | Troca o responsável em lote (fatiamento automático). |
| `kommo_bulk_update_leads` | `lead_ids[]`*, `status_id`, `pipeline_id`, `responsible_user_id`, `price`, `loss_reason_id`, `tags_to_add[]` | Atualização em massa com blocos de 200 e relatório de sucesso/falha. |
| `kommo_add_note` | `entity_id`*, `text`*, `entity`, `note_type` (`common`/`call_in`/`call_out`), `params_extra` | Adiciona nota ou registro de ligação. |
| `kommo_create_task` | `text`*, `entity_id`, `entity`, `complete_till`, `responsible_user_id`, `task_type_id` (tipos reais da conta na descrição) | Cria tarefa (prazo padrão: +1 dia). |
| `kommo_complete_task` | `task_id`*, `result` | Conclui uma tarefa com resultado opcional. |

### Contatos & empresas

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_create_contact` | `name`/`first_name`/`last_name`, `phone`, `email`, `responsible_user_id`, `custom_fields_values` | Cria contato (telefone/email viram campos PHONE/EMAIL). |
| `kommo_update_contact` | `contact_id`*, `name`, `responsible_user_id`, `custom_fields_values` | Atualiza um contato. |
| `kommo_create_company` | `name`*, `responsible_user_id`, `custom_fields_values` | Cria empresa. |
| `kommo_update_company` | `company_id`*, `name`, `responsible_user_id`, `custom_fields_values` | Atualiza uma empresa. |
| `kommo_link` | `entity`*, `entity_id`*, `to_entity_type`* (inclui `catalog_elements`), `to_entity_id`*, `catalog_id`, `quantity` | Vincula entidades, inclusive produto/procedimento a lead. |

### Funis/etapas

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_create_status` | `pipeline_id`*, `name`*, `sort`, `color` | Cria uma etapa num funil. |
| `kommo_update_status` | `pipeline_id`*, `status_id`*, `name`, `sort`, `color` | Renomeia/reordena/recolore uma etapa. |

### Webhooks

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_subscribe_webhook` | `destination`* (URL), `settings`* (eventos) | Assina eventos da Kommo numa URL. |
| `kommo_delete_webhook` | `destination`* | Cancela um webhook pela URL. |

### Campos personalizados

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_create_custom_field` | `entity`, `name`*, `type`, `enums` | Cria campo custom (use `enums` para select/multiselect). |
| `kommo_update_custom_field` | `entity`, `field_id`*, `name`, `add_enums[]` | Renomeia e/ou acrescenta opções a um select preservando as existentes. |

### Catálogo, arquivos e automação

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_create_catalog_element` | `catalog_id`*, `name`*, `custom_fields_values` | Cria um elemento (ex.: procedimento com preço). |
| `kommo_upload_file` | `file_path`*, `file_name`, `entity`, `entity_id` | Sobe arquivo ao drive e anexa à entidade, se informada. |
| `kommo_run_salesbot` | `bot_id`*, `entity_id`*, `entity_type` | **Dispara um Salesbot num lead (envia mensagens reais). Confirme sempre.** |

### Genérico

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_request` | `method`, `path`*, `query`, `body` | Chamada autenticada a qualquer endpoint; restrita a hosts `*.kommo.com` da conta. |

`*` = obrigatório.

---

## Estrutura do projeto

```
kommo-mcp/
├── index.mjs        # Servidor MCP: 41 tools, 4 prompts, 8 resources, transporte stdio
├── kommo.mjs        # Cliente HTTP (allowlist de hosts, retry/backoff, timeout, cache) + .env
├── smoke.mjs        # Teste end-to-end: sobe o server e valida contra a API real
├── package.json
├── .env.example     # Modelo das variáveis (copie para .env)
├── .gitignore       # Ignora .env e node_modules
├── LICENSE
└── README.md
```

---

## Segurança

- **Allowlist de hosts:** o cliente HTTP só envia o token para `{seu-subdomínio}.kommo.com` e
  `drive*.kommo.com`. Mesmo que alguém induza o assistente a chamar `kommo_request` com uma URL
  externa (prompt injection via dados do CRM), o token **não sai** da infraestrutura da Kommo.
- **Annotations MCP:** leituras declaram `readOnlyHint`, escritas declaram `destructiveHint`,
  permitindo que o cliente aplique permissões distintas por protocolo.
- **Nunca** versione o `.env` (já protegido pelo `.gitignore`). Para compartilhar configuração,
  use o `.env.example`.
- O token tem os **direitos de admin** de quem o gerou — trate como senha.
- Se um token vazar, **gere outro** na Kommo: isso invalida o anterior imediatamente.
- Prefira o **escopo mínimo** (`crm`) ao criar a integração privada.
- Rode o servidor numa máquina/servidor sob seu controle.

---

## Limitações conhecidas

- **Salesbot nativo da Kommo:** o *fluxo/cenário* do bot é editável **apenas pela interface** da
  Kommo. Pela API dá para **ler tudo o que o bot fez** (via `kommo_get_events` / notas) e
  **dispará-lo num lead** (`kommo_run_salesbot`) — mas **não** redesenhar o fluxo.
- **Mensagens de chat (amojo):** ler/enviar o conteúdo das conversas exige registrar um canal
  próprio na Chats API (credencial separada); está fora do escopo deste servidor.
- **Módulo Customers:** só funciona em contas com o módulo habilitado no plano
  (`customers_mode` diferente de `disabled`); alcançável via `kommo_request` se for o caso.
- **v2.x muda o formato das listagens** para `{ items, page, has_more }` com itens resumidos
  (v1.x devolvia o array cru). Use `raw: true` onde precisar do payload original.

---

## Troubleshooting

**`HTTP 401 Invalid user name or password`**
O token foi rejeitado. Causas comuns:
- O subdomínio (`KOMMO_SUBDOMAIN`) e o token são de **contas diferentes**. Confirme o subdomínio
  na URL ao logar na Kommo (a parte antes de `.kommo.com`).
- A integração privada está **desativada/em rascunho**, ou você **gerou um token novo depois**
  (o que invalida o anterior). Gere um token novo e atualize o `.env`.
- O usuário que criou a integração não é mais **admin** ou foi desativado.

**As tools não aparecem no Claude Code**
Reinicie o Claude Code após `claude mcp add` — servidores MCP só carregam no início da sessão.
Confira com `claude mcp get kommo`.

**`Faltam KOMMO_SUBDOMAIN e/ou KOMMO_TOKEN`**
O `.env` não foi encontrado ou está incompleto. Confirme que ele existe na raiz do projeto e
tem as duas variáveis.

---

## Deploy em servidor (VPS)

Como o transporte é **stdio**, o servidor roda **sob demanda** quando o cliente MCP o invoca —
não precisa ficar de pé como serviço de rede. Para usar numa VPS:

```bash
git clone https://github.com/RonaldoESantosRevOps/kommo-mcp.git
cd kommo-mcp && npm install
cp .env.example .env   # preencha com seu subdomínio e token
```

E aponte o cliente MCP para o caminho do `index.mjs` nesse servidor.

---

## Licença

[MIT](./LICENSE) © Ronaldo E. Santos
