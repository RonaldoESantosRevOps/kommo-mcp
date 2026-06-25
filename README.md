# kommo-mcp

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

**29 tools** divididas em:

| Categoria | Tools |
|---|---|
| **Leitura** | `kommo_account`, `kommo_pipelines`, `kommo_users`, `kommo_custom_fields`, `kommo_search_leads`, `kommo_get_lead`, `kommo_list_tasks`, `kommo_search_contacts`, `kommo_search_companies`, `kommo_list_webhooks` |
| **Auditoria** | `kommo_get_events` (feed de eventos; filtre `created_by=0` para ações de bot/automação) |
| **Leads** | `kommo_create_lead`, `kommo_update_lead`, `kommo_change_responsible` |
| **Tarefas & notas** | `kommo_create_task`, `kommo_complete_task`, `kommo_add_note` |
| **Contatos & empresas** | `kommo_create_contact`, `kommo_update_contact`, `kommo_create_company`, `kommo_update_company`, `kommo_link` |
| **Funis/etapas** | `kommo_create_status`, `kommo_update_status` |
| **Webhooks** | `kommo_subscribe_webhook`, `kommo_delete_webhook` |
| **Campos custom** | `kommo_create_custom_field`, `kommo_update_custom_field` |
| **Genérico** | `kommo_request` (passthrough autenticado para qualquer endpoint da API v4) |

A referência completa de parâmetros está [mais abaixo](#referência-das-tools).

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
✓ tools expostas: 29
✓ kommo_account -> <Nome da sua conta> (id ..., BRL)
✓ kommo_pipelines -> N funis; principal: ...
✓ kommo_users -> N usuários: ...
✓ kommo_search_leads(limit 3) -> 3 leads
✓ kommo_get_events(created_by=0, limit 5) -> 5 eventos de bot/sistema
✓ SMOKE OK
```

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
      "mcp__kommo__kommo_get_events"
    ]
  }
}
```

Todas as tools de escrita (criar/editar leads, contatos, empresas, tarefas, notas, etapas,
campos custom, vínculos e webhooks) e o passthrough `kommo_request` **continuam pedindo
confirmação** — o comportamento seguro recomendado.

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
> `kommo_pipelines` e `kommo_users`.

### Leitura

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_account` | — | Dados da conta (confirma a conexão). |
| `kommo_pipelines` | — | Lista funis e suas etapas (`id`, `name`, `sort`). |
| `kommo_users` | — | Lista usuários (`id`, `name`, `email`). |
| `kommo_custom_fields` | `entity` (`leads`/`contacts`/`companies`) | Lista campos personalizados e seus `id`. |
| `kommo_search_leads` | `query`, `pipeline_id`, `status_id`, `responsible_user_id`, `limit`, `page` | Busca leads com contatos embutidos. |
| `kommo_get_lead` | `lead_id`, `note_limit` | Detalhe de um lead; anexa as últimas notas se `note_limit>0`. |
| `kommo_list_tasks` | `responsible_user_id`, `entity_id`, `entity_type`, `is_completed`, `limit`, `page` | Lista tarefas. |
| `kommo_search_contacts` | `query`, `limit`, `page` | Busca contatos por texto/telefone/email. |
| `kommo_search_companies` | `query`, `limit`, `page` | Busca empresas por texto. |
| `kommo_list_webhooks` | — | Lista os webhooks configurados (destino e eventos). |

### Auditoria

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_get_events` | `entity`, `entity_id`, `type[]`, `created_by[]`, `from`, `to`, `limit`, `page` | Feed de eventos. **`created_by=0` = ações de bot/automação.** Útil para entender o que mudou, quando e por quem. |

### Escrita

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_create_lead` | `name`*, `price`, `pipeline_id`, `status_id`, `responsible_user_id`, `contact_name`, `contact_phone`, `custom_fields_values` | Cria lead; vincula contato se informado. |
| `kommo_update_lead` | `lead_id`*, `name`, `price`, `status_id`, `pipeline_id`, `responsible_user_id`, `custom_fields_values` | Atualiza lead (mover etapa/funil, preço, etc.). |
| `kommo_change_responsible` | `lead_ids[]`*, `responsible_user_id`* | Troca o responsável de vários leads de uma vez. |
| `kommo_add_note` | `entity_id`*, `text`*, `entity` | Adiciona nota a um lead/contato/empresa. |
| `kommo_create_task` | `text`*, `entity_id`, `entity`, `complete_till`, `responsible_user_id`, `task_type_id` | Cria tarefa (prazo padrão: +1 dia). |
| `kommo_complete_task` | `task_id`*, `result` | Conclui uma tarefa com resultado opcional. |

### Contatos & empresas

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_create_contact` | `name`/`first_name`/`last_name`, `phone`, `email`, `responsible_user_id`, `custom_fields_values` | Cria contato (telefone/email viram campos PHONE/EMAIL). |
| `kommo_update_contact` | `contact_id`*, `name`, `responsible_user_id`, `custom_fields_values` | Atualiza um contato. |
| `kommo_create_company` | `name`*, `responsible_user_id`, `custom_fields_values` | Cria empresa. |
| `kommo_update_company` | `company_id`*, `name`, `responsible_user_id`, `custom_fields_values` | Atualiza uma empresa. |
| `kommo_link` | `entity`*, `entity_id`*, `to_entity_type`*, `to_entity_id`* | Vincula entidades (ex.: contato↔lead, empresa↔lead). |

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
| `kommo_update_custom_field` | `entity`, `field_id`*, `name` | Atualiza/renomeia um campo custom. |

### Genérico

| Tool | Parâmetros principais | O que faz |
|---|---|---|
| `kommo_request` | `method`, `path`*, `query`, `body` | Chamada autenticada a qualquer endpoint da API v4. |

`*` = obrigatório.

---

## Estrutura do projeto

```
kommo-mcp/
├── index.mjs        # Servidor MCP: define as 29 tools e o transporte stdio
├── kommo.mjs        # Cliente HTTP da API v4 + carregador de .env (sem dependências extras)
├── smoke.mjs        # Teste end-to-end: sobe o server e chama tools de leitura
├── package.json
├── .env.example     # Modelo das variáveis (copie para .env)
├── .gitignore       # Ignora .env e node_modules
├── LICENSE
└── README.md
```

---

## Segurança

- **Nunca** versione o `.env` (já protegido pelo `.gitignore`). Para compartilhar configuração,
  use o `.env.example`.
- O token tem os **direitos de admin** de quem o gerou — trate como senha.
- Se um token vazar, **gere outro** na Kommo: isso invalida o anterior imediatamente.
- Prefira o **escopo mínimo** (`crm`) ao criar a integração privada.
- Rode o servidor numa máquina/servidor sob seu controle.

---

## Limitações conhecidas

- **Salesbot nativo da Kommo:** o *fluxo/cenário* do bot é editável **apenas pela interface** da
  Kommo. Pela API dá para **ler tudo o que o bot fez** (via `kommo_get_events` / notas) e, via
  `kommo_request`, disparar/parar — mas **não** redesenhar o fluxo.

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
