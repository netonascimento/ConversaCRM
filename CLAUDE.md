# Conversa CRM

Plataforma SaaS (multiempresa) de atendimento com IA no WhatsApp, agenda, CRM, follow-up, cobrança, prospecção e dashboard. Interface e textos em português do Brasil.

## Rodar e testar

- Node.js 22.13+ (usa o SQLite embutido, `node:sqlite`). Sem banco externo.
- `npm install`, `npm run seed` (clínica de exemplo) ou `npm run seed:advocacia`, `npm start` → http://localhost:3000
  - `/` landing, `/app` sistema, `/admin` painel do administrador (`npm run admin:create -- email senha "Nome"`).
- `npm test` roda todos os testes (`node --test`, banco em memória). Rode antes de cada push; o GitHub Actions roda também.
- `npm run build:demo` gera `dist/conversacrm-demo.html`, que roda o sistema inteiro no navegador (SQLite em WebAssembly).

## Estrutura

- `src/server.js` servidor HTTP sem framework; `src/http.js` roteador mínimo.
- `src/routes/api.js` API do sistema (com controle por perfil: dono, atendente, profissional), `routes/admin.js` painel, `routes/webhooks.js` WhatsApp e pagamentos.
- `src/services/` regras de negócio: `ai.js` (agente Claude com ferramentas e respostas automáticas sem chave), `scheduling.js`, `professionals.js`, `google.js` (Google Agenda), `billing.js`, `followup.js`, `tasks.js`, `crm.js`, `messaging.js`, `plans.js`, `presets.js`.
- `src/db.js` esquema e migrações. Banco principal (empresas, usuários, sessões) + dados das empresas; empresas especiais podem ter banco separado (`storage = 'dedicated'`). Use `all/get/run` para dados da empresa (roteados pelo contexto `withCompanyDb`) e `main.*` para empresas/usuários/sessões.
- `public/` front-end sem build: `app.js` (sistema), `admin.js`, `landing.html`, páginas por público (`mei.html`, `advogados.html`, `crm.html`, com `lp.css` e `lp.js`), `import.js` (leitura de CSV/VCF).
- Design: `public/ds.css` + `DESIGN.md` são a fonte única de cores, tipografia, espaçamento e componentes. Não invente estilos fora do design system.

## Convenções

- Toda tabela de dados tem `company_id`; toda consulta filtra pela empresa da sessão. Teste o isolamento entre empresas ao criar rotas.
- Colunas novas entram em `COLUMNS` (`src/db.js`) para migrar bancos existentes.
- Comentários e mensagens ao usuário em português; código e nomes em inglês.
- Segredos (chaves de API, tokens) nunca voltam inteiros para o front (`maskSettings`) nem saem em exportações.
