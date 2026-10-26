# Segurança

kommo-mcp fala com a API da Kommo usando o token de quem instalou. O processo roda na máquina dessa pessoa, por stdio. Não há serviço no meio e o repositório não contém conta, token ou dados de CRM.

## O que o servidor já faz

- O token só é enviado para `https://{subdomínio}.kommo.com` e para `https://drive*.kommo.com`.
- URL `http`, porta explícita, usuário/senha na URL e host fora dessa lista são recusados antes da rede.
- Redirecionamentos não são seguidos. Um 302 não carrega o token para outro site.
- `KOMMO_SUBDOMAIN` precisa ser um único rótulo DNS. Um valor com `https://`, caminho ou outro domínio não vira URL.
- Cabeçalhos `Authorization`, `Host` e `Cookie` recebidos de uma tool não substituem o token.
- `GET` e `429` podem ser repetidos. `POST`, `PATCH`, `PUT` e `DELETE` não são repetidos em erro 5xx, para não duplicar uma gravação.
- Há um intervalo mínimo entre chamadas (padrão 200 ms).
- `KOMMO_READ_ONLY=1` recusa tools de escrita e limita `kommo_request` a `GET`.
- Lotes de leads param em 1000 ids.
- Upload recusa `.env`, chaves, diretórios privados e qualquer arquivo que contenha o token.
- Webhook novo precisa ser HTTPS e não pode apontar de volta para a API da Kommo.
- A resposta de erro é cortada e o token, se aparecer, é substituído por `[redacted]`.
- Nomes de tipo de tarefa entram na descrição da tool sem quebra de linha.
- Argumentos de prompt só aceitam número ou data `YYYY-MM-DD`.

## O que continua sendo decisão de quem usa

O texto que volta do CRM (nome, nota, mensagem, nome de etapa) é dado não confiável. Um lead pode conter uma frase pedindo para apagar a base ou enviar o arquivo `.env`. O servidor avisa o modelo disso nas instruções, mas quem aplica a permissão é o cliente MCP.

Recomendação:

1. Comece com `KOMMO_READ_ONLY=1` até confiar no fluxo.
2. No cliente, libere só as tools com `readOnlyHint`.
3. Mantenha confirmação humana em escrita, lote, webhook, upload e Salesbot.
4. Crie o token com o menor escopo que a conta permitir. `crm` cobre as tools deste servidor.
5. Guarde o `.env` só na máquina que roda o servidor (`chmod 600 .env`) e não o coloque num `mcp.json` versionado.
6. Se o token vazar, gere outro na Kommo. O anterior deixa de valer.

`kommo_request` alcança qualquer endpoint permitido pelo token. Trate essa tool como escrita, mesmo num `GET`.

## Reportar uma falha

Abra um [advisory privado](https://github.com/RonaldoESantosRevOps/kommo-mcp/security/advisories/new) ou uma issue sem token, sem subdomínio e sem dados de leads. Não envie e-mail com segredo.

Se você mesmo publicou um token sem querer, revogue-o na Kommo antes de qualquer outra coisa.
