# kommo-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-server-2563eb)](https://modelcontextprotocol.io)

Self-hosted [MCP](https://modelcontextprotocol.io) server for [Kommo](https://www.kommo.com) (API v4).
Point it at **your** account with a long-lived token. The repository has no account, no token and no CRM export. Tool descriptions are in Portuguese.

Servidor MCP self-hosted para a Kommo. Cada pessoa usa o próprio subdomínio e o próprio token. Nada disso vem no código.

O assistente passa a ler e, se você permitir, alterar leads, contatos, tarefas, funis e a fila de atendimento. As credenciais ficam na máquina que roda o processo e só saem para a API da Kommo.

## Segurança

O detalhe está em [SECURITY.md](./SECURITY.md). O resumo:

- O token só vai para `https://{sua-conta}.kommo.com` e `https://drive*.kommo.com`.
- HTTP, outro host, porta explícita e redirecionamento são recusados.
- `KOMMO_READ_ONLY=1` bloqueia escrita.
- Upload não envia `.env`, chave privada nem arquivo que contenha o token.
- Texto vindo do CRM é dado, não instrução. Confirme escrita, lote, webhook e Salesbot no cliente.

## Requisitos

- Node.js 18 ou mais novo (22 no desenvolvimento).
- Conta Kommo com permissão para criar uma integração privada.
- Um cliente MCP: Cursor, Claude Code, Claude Desktop ou outro que fale stdio.

## Começo rápido

```bash
git clone https://github.com/RonaldoESantosRevOps/kommo-mcp.git
cd kommo-mcp
npm install
cp .env.example .env
chmod 600 .env
```

Preencha `.env`:

```env
KOMMO_SUBDOMAIN=minhaempresa
KOMMO_TOKEN=
```

`minhaempresa` é o rótulo de `https://minhaempresa.kommo.com`. Não cole a URL inteira.

O token nasce em **Configurações → Integrações → integração privada → Chaves e escopos → Gerar token de longa duração**. O escopo `crm` cobre as tools. Trate o token como senha: ele age com os direitos de quem o gerou. Se vazar, gere outro. O anterior deixa de valer.

Documentação da Kommo: <https://pt-developers.kommo.com/docs/token-de-longa-duração>

Confira a instalação sem conta:

```bash
npm test
```

Confira a conta de verdade (a saída não imprime nome, telefone nem token):

```bash
npm run smoke
```

## Variáveis

| Variável | Padrão | Função |
|---|---|---|
| `KOMMO_SUBDOMAIN` | — | Rótulo da conta. Obrigatório. |
| `KOMMO_TOKEN` | — | Token de longa duração. Obrigatório. |
| `KOMMO_READ_ONLY` | `0` | `1` recusa escrita e limita `kommo_request` a GET. |
| `KOMMO_MIN_INTERVAL_MS` | `200` | Pausa mínima entre chamadas. `0` desliga. |
| `KOMMO_UPLOAD_MAX_BYTES` | `20971520` | Teto do upload (20 MiB). Máximo aceito: 100 MiB. |
| `KOMMO_REDACT_USER_EMAILS` | `0` | `1` omite e-mail em `kommo_users` e em `kommo://users`. |

Variável já presente no ambiente ganha do `.env`. O arquivo é lido ao lado do `index.mjs`.

## Clientes

O transporte é stdio. O processo sobe quando o cliente chama e encerra junto com a sessão. Não é um serviço de rede.

### Cursor e Claude Desktop

Arquivo do usuário, não do repositório. Exemplo em [`examples/mcp.json`](./examples/mcp.json):

```json
{
  "mcpServers": {
    "kommo": {
      "command": "node",
      "args": ["/caminho/absoluto/kommo-mcp/index.mjs"]
    }
  }
}
```

Deixe o token no `.env` do servidor. Um `mcp.json` de projeto com token entra no Git com facilidade.

### Claude Code

```bash
claude mcp add kommo -s user -- node /caminho/absoluto/kommo-mcp/index.mjs
claude mcp get kommo
```

Reinicie a sessão depois de registrar. Escopo `user` vale em todos os projetos. `project` grava `.mcp.json` no repositório: não coloque o token nele.

Para liberar só leitura em `~/.claude/settings.json`:

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

As 16 tools de leitura também declaram `readOnlyHint`. Escrita, webhook, upload, Salesbot e `kommo_request` continuam pedindo confirmação.

### Pedidos úteis

- "Liste leads sem atualização há 14 dias na etapa Novo."
- "O que as automações fizeram nas últimas 6 horas? Use created_by 0."
- "Crie um lead 'Contato exemplo', telefone +55 11 90000-0000, na primeira etapa do funil principal."
- "Mova o lead 12345 para a etapa Proposta e troque o responsável."
- "Crie uma tarefa de retorno amanhã às 10h no lead 12345."

Prompts prontos: `auditoria-do-dia`, `fila-agora`, `leads-parados`, `relatorio-perdas`.

Resources: `kommo://account`, `kommo://pipelines`, `kommo://users`, `kommo://custom-fields/leads`, `kommo://custom-fields/contacts`, `kommo://custom-fields/companies`, `kommo://loss-reasons`, `kommo://task-types`.

## Referência

41 tools. Listagens devolvem `{ items, page, has_more }`. Datas de entrada aceitam ISO ou epoch em segundos. `raw: true`, onde existe, devolve o payload da API. Ids de funil, etapa e usuário saem de `kommo_pipelines` e `kommo_users`.

`*` = obrigatório.

### Leitura

| Tool | Parâmetros | Função |
|---|---|---|
| `kommo_account` | — | Confirma a conexão. |
| `kommo_pipelines` | — | Funis e etapas. |
| `kommo_users` | — | Usuários, com `is_active` e `is_admin`. |
| `kommo_custom_fields` | `entity` | Campos de leads, contatos ou empresas. |
| `kommo_search_leads` | `query`, `pipeline_id`, `status_id`, `responsible_user_id`, datas, `order_by`, `fields`, `raw`, `limit`, `page` | Busca resumida. `query` tem no mínimo 3 caracteres. `status_id` sozinho resolve o funil quando a etapa é única. |
| `kommo_get_lead` | `lead_id`*, `note_limit` | Detalhe. `note_limit` anexa até 50 notas. |
| `kommo_list_tasks` | `responsible_user_id`, `entity_id`, `entity_type`, `is_completed`, `limit`, `page` | Tarefas resumidas. |
| `kommo_search_contacts` | `query`, `raw`, `limit`, `page` | Contatos, com telefone, e-mail e leads vinculados. |
| `kommo_search_companies` | `query`, `raw`, `limit`, `page` | Empresas. |
| `kommo_list_webhooks` | — | Webhooks da conta. |
| `kommo_tags` | `entity`, `query`, `limit`, `page` | Tags. |
| `kommo_loss_reasons` | — | Motivos de perda. |
| `kommo_catalog_elements` | `catalog_id`*, `query`, `limit`, `page` | Itens de um catálogo. |
| `kommo_get_events` | `entity`, `entity_id`, `type`, `created_by`, `from`, `to`, `raw`, `limit`, `page` | Auditoria. `created_by` 0 é bot ou automação. |
| `kommo_talks` | `is_in_work`, `is_read`, `contact_id`, `limit`, `page` | Fila de conversas. |
| `kommo_unsorted` | `category`, `pipeline_id`, `summary`, `limit`, `page` | Inbox. `summary: true` devolve o agregado. |

### Escrita

| Tool | Parâmetros | Função |
|---|---|---|
| `kommo_create_lead` | `name`*, `price`, `pipeline_id`, `status_id`, `responsible_user_id`, `contact_name`, `contact_phone`, `tags`, `custom_fields_values` | Cria lead e, se houver contato, vincula. |
| `kommo_update_lead` | `lead_id`*, campos, `tags_to_add`, `tags_to_remove` | Atualiza sem apagar as outras tags. |
| `kommo_change_responsible` | `lead_ids`*, `responsible_user_id`* | Troca responsável. Até 1000 ids, em blocos de 200. |
| `kommo_bulk_update_leads` | `lead_ids`*, etapa, responsável, preço, motivo, `tags_to_add` | Mesmo teto e o mesmo fatiamento. |
| `kommo_add_note` | `entity_id`*, `text`*, `entity`, `note_type`, `params_extra` | Nota comum ou registro de ligação. |
| `kommo_create_task` | `text`*, `entity_id`, `entity`, `complete_till`, `responsible_user_id`, `task_type_id` | Tarefa. Prazo padrão: um dia. |
| `kommo_complete_task` | `task_id`*, `result` | Conclui a tarefa. |
| `kommo_create_contact` / `kommo_update_contact` | nome, `phone`, `email`, responsável, campos | Telefone e e-mail viram PHONE e EMAIL. |
| `kommo_create_company` / `kommo_update_company` | `name`, responsável, campos | Empresas. |
| `kommo_link` | `entity`*, `entity_id`*, `to_entity_type`*, `to_entity_id`*, `catalog_id`, `quantity` | Liga contato, empresa ou item de catálogo. |
| `kommo_create_status` / `kommo_update_status` | funil, nome, `sort`, `color` | Etapas. Cor em hex, por exemplo `#fffeb2`. |
| `kommo_subscribe_webhook` | `destination`*, `settings`* | Assina eventos numa URL HTTPS sua. |
| `kommo_delete_webhook` | `destination`* | Remove pela URL. |
| `kommo_create_custom_field` / `kommo_update_custom_field` | entidade, nome, tipo, `enums` ou `add_enums` | Cria campo ou acrescenta opção de select. |
| `kommo_unsorted_accept` / `kommo_unsorted_decline` | `uid`*, `user_id`, `status_id` | Aceita ou rejeita um item do Inbox. |
| `kommo_close_talk` | `talk_id`*, `force_close` | Fecha uma conversa. |
| `kommo_create_catalog_element` | `catalog_id`*, `name`*, campos | Novo item de catálogo. |
| `kommo_upload_file` | `file_path`*, `file_name`, `entity`, `entity_id` | Sobe ao drive e pode anexar. |
| `kommo_run_salesbot` | `bot_id`*, `entity_id`*, `entity_type` | Dispara um bot. Pode enviar mensagem real. Confirme antes. |
| `kommo_request` | `method`, `path`*, `query`, `body` | Endpoint ainda sem tool. Preso à allowlist. |

A etapa de entrada (Inbox) não filtra em `/leads`. Use `kommo_unsorted`. Os status 142 e 143 existem em mais de um funil: informe `pipeline_id`.

## Desenvolvimento

```text
kommo-mcp/
├── index.mjs              # entrada stdio
├── src/
│   ├── server.mjs         # protocolo MCP
│   ├── handlers.mjs       # tools
│   ├── tools.mjs          # contratos
│   ├── prompts.mjs
│   ├── http.mjs           # allowlist, retry, ritmo
│   ├── catalog.mjs        # cache de funis, usuários e campos
│   ├── format.mjs
│   ├── validate.mjs
│   └── config.mjs
├── tests/                 # npm test não precisa de conta
├── examples/mcp.json
├── .env.example
├── SECURITY.md
├── CONTRIBUTING.md
└── CHANGELOG.md
```

```bash
npm test          # allowlist, validação, handlers com API falsa
npm run smoke     # opcional, contra a sua conta
```

Quem for contribuir: [CONTRIBUTING.md](./CONTRIBUTING.md).

## Limitações

- O fluxo do Salesbot só é editado na interface da Kommo. Por aqui dá para ler o que ele fez e dispará-lo num lead.
- O conteúdo das conversas (Chats API) pede credencial à parte e fica fora deste servidor.
- O módulo de customers, quando o plano tem, é alcançável por `kommo_request`.
- A partir da 2.0, listagem resumida usa `{ items, page, has_more }`. `raw: true` devolve o payload original onde a tool oferece essa opção.
- Datas ISO sem fuso são interpretadas no fuso da máquina que roda o servidor. Epoch em segundos não depende disso.

## Problemas comuns

**`Faltam KOMMO_SUBDOMAIN e/ou KOMMO_TOKEN`**
O `.env` não está ao lado do `index.mjs`, ou o cliente MCP não está com o diretório certo. Caminho absoluto no `args` evita essa dúvida.

**`KOMMO_SUBDOMAIN inválido`**
Use só o rótulo (`minhaempresa`), não `https://minhaempresa.kommo.com/`.

**`HTTP 401`**
Subdomínio e token são de contas diferentes, a integração está desligada, ou um token novo invalidou o anterior.

**`KOMMO_READ_ONLY está ativo`**
A tool grava dados. Troque a variável para `0` se essa escrita for intencional.

**`Host fora da allowlist`**
`kommo_request` recebeu um host que não é o da conta. O token não foi enviado.

**Tools não aparecem**
Reinicie o cliente depois de registrar o servidor.

## Licença

[MIT](./LICENSE) © Ronaldo E. Santos
