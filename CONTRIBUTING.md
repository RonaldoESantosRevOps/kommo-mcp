# Contribuir

O projeto é genérico de propósito. Uma alteração que só faça sentido para uma conta, um funil ou um campo com nome próprio não entra.

## Ambiente

Node.js 18 ou mais novo. Node 22 é a versão usada no desenvolvimento.

```bash
npm install
npm test
```

`npm run smoke` chama a API real da conta configurada no `.env`. A saída omite nome, telefone e token. Mesmo assim, não cole o log numa issue.

## O que não entra no Git

- `.env`, token, exportação de leads, print de CRM, e-mail de usuário da conta.
- Caminho absoluto da sua máquina dentro de exemplo ou teste.
- Descrição de tool com o nome de um campo ou de uma etapa da sua operação.

O teste `tests/leak.test.mjs` barra uma lista de termos. Se ele falhar, tire o dado do arquivo em vez de enfraquecer o teste.

## Pull request

- Rode `npm test`.
- Se mexeu em query string, allowlist, lote ou formato de resposta, acrescente ou ajuste um teste em `tests/`.
- Mantenha os nomes das tools e o formato `{ items, page, has_more }` das listagens.
- Descreva mudança de comportamento no `CHANGELOG.md`.
