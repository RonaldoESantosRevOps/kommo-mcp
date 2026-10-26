# Changelog

## 2.1.0

Segurança e estrutura para uso em qualquer conta.

- O token só sai por HTTPS para o host da conta e para `drive*.kommo.com`. Redirecionamento não é seguido.
- Subdomínio inválido, token de exemplo e token com espaço ou quebra de linha são recusados na subida.
- `KOMMO_READ_ONLY`, limite de lote (1000), intervalo entre chamadas e tamanho máximo de upload.
- Upload recusa arquivo de segredo e arquivo que contenha o token.
- Webhook novo exige HTTPS e não pode apontar para a API da Kommo.
- Tags passam a usar `tags_to_add` e `tags_to_delete`, sem reler e regravar a lista inteira.
- `status_id` sem `pipeline_id` também resolve o funil em criação, atualização e lote.
- Usuários e campos personalizados paginam além do primeiro bloco de 250.
- Busca de contatos pede os leads vinculados.
- Erro devolvido ao cliente não inclui o token. O log de subida não imprime o subdomínio.
- Escrita não é repetida em erro 5xx. `GET` e `429` continuam com retry limitado.
- Código dividido em `src/`. Testes sem conta real em `npm test`. Smoke opcional não imprime dados da conta.
- SDK do MCP atualizado para a linha 1.32, com as correções de segurança publicadas dessa linha.

## 2.0.0

Allowlist de hosts, retry, respostas resumidas e tools novas (29 para 41).
