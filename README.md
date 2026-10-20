# Falaki CRM

Sistema integrado para qualquer empresa **prospectar, atender, vender, agendar e cobrar**, tudo no mesmo lugar e conectado ao WhatsApp:

| Módulo | O que faz |
|---|---|
| 🤖 **Atendimento com IA no WhatsApp** | Responde 24h com o Claude (Anthropic): tira dúvidas com base no seu catálogo, consulta horários livres, **agenda**, remarca, cancela, salva dados no CRM, **gera cobrança** e passa para um humano quando precisa. |
| 📅 **Agendamento inteligente** | Agenda semanal, horários livres calculados pelo horário de funcionamento, duração de cada serviço, capacidade simultânea, feriados e **lembrete automático** pelo WhatsApp. |
| 👥 **CRM / funil** | Kanban (Novo → Em contato → Qualificado → Proposta → Ganho/Perdido) com arrastar e soltar, ficha completa do cliente e histórico de tudo que aconteceu. As etapas avançam sozinhas (cliente respondeu, agendou, pagou). |
| 🗂️ **Clientes, contratos e documentos** | Lista de clientes (quem fechou ou tem contrato), contratos com início, vencimento e aviso X dias antes: a equipe recebe uma tarefa para renovar, e o contrato pode renovar sozinho. Documentos (PDF, imagens, Word, Excel…) por cliente, por contrato ou gerais da empresa. Valores dos contratos só para o dono. |
| 🔁 **Follow-up automático** | Sequências de mensagens com gatilhos (novo lead, mudou de etapa, prospect importado, manual). Só envia em horário comercial, **para sozinha quando o cliente responde** e pode personalizar cada mensagem com IA. |
| 💰 **Cobrança com IA** | Pix copia e cola (com sua chave, sem intermediário), **Asaas** ou **Mercado Pago** com baixa automática por webhook. Régua de lembretes educada antes e depois do vencimento. Pagamento confirmado → agradece o cliente e move o lead para "Ganho". |
| 📍 **Prospecção Google Maps** | Busca empresas locais ("academias em Campinas") com telefone, site, nota e avaliações, importa para o CRM e já coloca numa sequência de abordagem. |
| 📊 **Dashboard de gestão** | Faturamento, a receber, inadimplência, conversão, pipeline, funil, origem dos leads, agenda, mensagens da IA e **recomendações geradas por IA**. |

| 👩‍⚖️ **Profissionais** | Cada profissional (advogado, dentista, consultor) tem seus horários, folgas e os serviços que atende. A IA indica quem cuida do assunto e marca com quem estiver livre; o profissional recebe aviso no WhatsApp. Sem profissionais cadastrados, a agenda é única. |
| 📋 **Tarefas da equipe** | O que a IA não pode concluir sozinha (enviar horários, confirmar um agendamento, fazer orçamento, aprovar cobrança, urgência) vira uma tarefa com prazo em horas úteis. A equipe é avisada no WhatsApp, e se o prazo passar o cliente recebe um "ainda estamos verificando". |

Serve para **vender qualquer coisa**: você cadastra seus produtos/serviços e descreve o negócio, e a IA passa a atender com essas informações. Cada empresa tem sua própria conta, então dá para revender: um login por cliente, cada um com seu WhatsApp, IA, CRM e cobranças.

## Plataforma para várias empresas

O Falaki roda como serviço (SaaS): um único servidor atende várias empresas, cada uma com seus usuários, dados, WhatsApp e integrações.

- **Página inicial** (`/`): apresentação do produto e planos. O botão de teste grátis cria a conta da empresa no plano gratuito.
- **Sistema** (`/app`): onde cada empresa trabalha.
- **Painel do administrador** (`/admin`): só para você, dono da plataforma. Lá você:
  - cadastra empresas já com o modelo do segmento (clínica, advocacia, salão, loja, serviços, imobiliária) e o primeiro usuário;
  - define o plano e os limites (usuários e leads) de cada uma;
  - cria, edita, desativa usuários e redefine senhas;
  - suspende e reativa empresas (suspensa: ninguém entra e as automações param);
  - entra como a empresa para dar suporte (fica registrado no histórico);
  - exporta todos os dados de uma empresa (LGPD) e exclui a empresa;
  - move uma empresa para um **banco de dados separado**, em casos especiais.

Crie o primeiro administrador com `npm run admin:create -- voce@email.com SenhaForte123 "Seu nome"` ou pelas variáveis `ADMIN_EMAIL` e `ADMIN_PASSWORD`.

### Planos

| Plano | Preço | Usuários | Leads | IA |
|---|---|---|---|---|
| Teste grátis | R$ 0 | 1 | até 30 | não (cadeado leva para a assinatura) |
| Essencial | R$ 100/mês | 2 | até 100 | sim |
| Profissional | R$ 249/mês | até 10 | ilimitados | sim |

No teste grátis, tudo que usa IA fica bloqueado (respostas automáticas, "Responder com IA", follow-up personalizado, recomendações); o sistema funciona no modo manual. O cadeado leva para a tela de assinatura (`#/assinar`), com pagamento pelo **Stripe**:

- **Cartão:** assinatura mensal automática. O webhook ativa o plano, registra cada mensalidade, marca "cartão recusado" e, se a assinatura for encerrada, volta a empresa para o teste grátis. O cliente troca o cartão ou cancela na área do cliente do Stripe ("Gerenciar assinatura").
- **Pix:** um mês por pagamento (o Pix Automático do Stripe não está disponível para empresas no Brasil). O webhook confirma e soma o mês; perto do vencimento, o dono vê o aviso para pagar o próximo.

No `/admin`, a página **Financeiro** mostra recebidos (mês, 12 meses, cartão × Pix), a receber nos próximos 30 dias, em atraso, pedidos de Pix e assinantes por plano. Planos pagos colocados manualmente, sem pagamento, aparecem como "sem cobrança" e não entram na receita. O administrador ainda pode registrar um Pix na ficha da empresa (casos fora do Stripe).

Em desenvolvimento use a chave de **teste** do Stripe: chave de produção (`sk_live_`/`rk_live_`) fica bloqueada enquanto `PUBLIC_URL` for localhost. Para receber os webhooks no computador: `stripe listen --forward-to localhost:3000/webhooks/stripe` (o comando mostra o `STRIPE_WEBHOOK_SECRET`).

Os planos ficam em `src/services/plans.js`. O administrador pode ajustar os limites de uma empresa específica. No limite de leads, novos contatos (manuais, importados ou de números novos no WhatsApp) não entram no CRM até a empresa mudar de plano.

### Perfis de usuário

- **Dono:** acesso total, inclusive configurações, cobranças e usuários.
- **Atendente:** conversas, CRM, agenda, tarefas, follow-up e prospecção; não vê números financeiros nem configurações.
- **Profissional:** vê só a própria agenda e os clientes que têm atendimento com ele.

### Separação dos dados

Por padrão todas as empresas ficam num banco compartilhado, e cada registro pertence a uma empresa. O sistema só mostra a cada usuário os dados da empresa dele, e os testes automatizados verificam isso. Para clientes que exigem isolamento físico, o administrador move a empresa para um **banco separado**: um arquivo de dados só dela em `data/empresas/`, com o mesmo funcionamento.

### WhatsApp: a API oficial é opcional

Cada empresa escolhe como conectar:
- **Evolution API (QR Code):** usa o número que a empresa já tem, sem custo por mensagem. É a opção mais em conta para pequenas empresas. Não é a API oficial da Meta, então existe risco de bloqueio do número se houver uso abusivo (como disparo em massa).
- **WhatsApp Cloud API (oficial da Meta):** mais estável e indicada para volume alto. A Meta cobra por conversa iniciada pela empresa.
- **Simulador:** para testar sem número.

## Google Agenda

Cada profissional (ou a empresa, quando não há profissionais) clica em **Agenda → Google Agenda → Conectar** e autoriza uma vez. A partir daí:
- todo agendamento criado, remarcado ou cancelado no Falaki (pela equipe ou pela IA) aparece sozinho no Google Agenda, com nome e WhatsApp do cliente;
- compromissos marcados direto no Google bloqueiam aqueles horários no Falaki (eventos marcados como "disponível" não bloqueiam), e a IA não oferece o horário;
- os horários do Google são relidos a cada 10 minutos (ou na hora, pelo botão "Atualizar agora"), e envios que falharem são repetidos automaticamente.

**Configuração (uma vez, pelo dono da plataforma):**
1. No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto e ative a **Google Calendar API**.
2. Em **APIs e serviços → Tela de consentimento OAuth**, configure o app (tipo "Externo"), com o escopo `.../auth/calendar.events`.
3. Em **Credenciais → Criar credenciais → ID do cliente OAuth** (tipo "Aplicativo da Web"), cadastre o URI de redirecionamento `https://SEU-DOMINIO/api/google/callback`.
4. Coloque o ID e a chave secreta em `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`.

Enquanto o app estiver em modo de teste no Google, só os e-mails cadastrados como "usuários de teste" conseguem conectar. Para liberar a todos os clientes, publique o app; como ele usa um escopo de agenda, o Google pede uma verificação.

## Importar contatos

Em **CRM → Importar**, a empresa traz os clientes de:
- **planilhas** do Excel ou do Google Planilhas (CSV, com vírgula, ponto e vírgula ou tabulação), inclusive arquivos antigos do Excel com acentos;
- **texto colado** direto da planilha (copiar e colar);
- **contatos do celular**: arquivo `.vcf` exportado do Google Contatos ou do iCloud, ou o CSV do Google Contatos.

O Falaki reconhece as colunas sozinho (nome, telefone/celular/WhatsApp, e-mail, empresa, CPF/CNPJ, etiquetas, valor…), mostra uma prévia para conferir e:
- não duplica contatos com o mesmo telefone ou e-mail (e pode completar os dados que faltarem nos que já existem);
- permite escolher a etapa do funil, uma etiqueta para a importação e uma sequência de follow-up;
- respeita o limite de leads do plano.

Em **CRM → Exportar**, baixa todos os contatos em CSV, que abre direto no Excel.

## Comportamento da IA (Configurações → Comportamento da IA)

A IA é montada com blocos, e cada tipo de negócio é só uma combinação diferente deles:

| Bloco | Opções |
|---|---|
| **Objetivo** | Agendar · Vender · Fazer a triagem e passar para a equipe · Coletar pedido de orçamento · Tirar dúvidas |
| **Agenda** | Automático (agenda sozinha) · Com confirmação (reserva e a equipe confirma) · Sem agenda (anota a preferência e a equipe retorna com horários) · Link externo · Não agenda |
| **Preços** | Informa · "A partir de" · Só descreve · Não fala de valores |
| **Cobrança** | A IA gera · A IA pede e a equipe aprova · A IA não cobra |
| **Triagem** | Perguntas que a IA faz ao longo da conversa; cada resposta vira um campo na ficha do cliente |
| **Regras** | Situações urgentes (chama a equipe na hora) e o que a IA nunca deve fazer |

O modo define **quais ferramentas a IA recebe**, não só o texto das instruções: no modo "Sem agenda" ela não tem como marcar horário, então nunca inventa um. Exemplos:

- **Escritório de advocacia:** triagem e passar para a equipe, agenda com confirmação ou sem agenda, não fala de valores, cobrança nunca pela IA, urgência para "audiência marcada" ou "prazo vencendo", nunca dar parecer.
- **Dentista:** agendar, agenda automática, preço "a partir de", triagem com queixa principal, urgência para dor forte.
- **Loja:** vender, não agenda, informa preços, cobrança automática.

## Como rodar

Requisitos: **Node.js 22.13 ou superior** (usa o SQLite embutido no Node, sem banco externo).

```bash
git clone https://github.com/netonascimento/Falaki.git
cd Falaki
npm install
npm run seed     # opcional: cria uma empresa de demonstração com dados
npm start        # http://localhost:3000 (sistema em /app, administração em /admin)
```

Login da demonstração: `demo@falaki.me` / `demo1234`. Para um escritório de advocacia de exemplo (3 advogados, triagem, agenda com confirmação): `npm run seed:advocacia` e entre com `advocacia@falaki.me` / `demo1234`. Ou clique em **Cadastre sua empresa** para criar uma conta do zero.

Para testar sem conectar um número de WhatsApp, use o botão **📱 Simular cliente** na tela de Atendimento: a mensagem entra no CRM e a IA responde como responderia no WhatsApp de verdade.

### Variáveis de ambiente (`.env`)

Copie `.env.example` para `.env`. Todas são opcionais; as chaves também podem ser cadastradas pela tela de Configurações, por empresa.

| Variável | Para quê |
|---|---|
| `PORT` | Porta HTTP (padrão 3000) |
| `PUBLIC_URL` | Endereço público (ex.: `https://app.suaempresa.com`), usado nas URLs de webhook |
| `ANTHROPIC_API_KEY` | Chave da IA da plataforma (console.anthropic.com). Só é usada pelas empresas que o administrador marcar em /admin; o consumo de tokens fica registrado para cobrar à parte |
| `AI_MODEL` | Modelo Claude (padrão `claude-opus-5-5`) |
| `GOOGLE_PLACES_API_KEY` | Chave padrão da prospecção |
| `ALLOW_SIGNUP` | `false` para desligar o teste grátis pela página inicial (só o administrador cria empresas) |
| `SALES_WHATSAPP` | WhatsApp de vendas: os botões dos planos pagos abrem uma conversa com ele |
| `STRIPE_SECRET_KEY` (ou `STRIPE_API_KEY`) / `STRIPE_WEBHOOK_SECRET` | Assinatura no cartão e Pix pelo Stripe, e a verificação do webhook `/webhooks/stripe` |
| `EVOLUTION_URL` / `EVOLUTION_API_KEY` | Servidor Evolution API da plataforma: cada empresa conecta o WhatsApp só lendo um QR Code (o Falaki cria a conexão e o aviso de mensagens sozinho). Pelo QR Code, a prospecção manda no máximo 20 primeiras mensagens por dia |
| `PLATFORM_PIX_KEY` / `PLATFORM_PIX_NAME` / `PLATFORM_PIX_CITY` | Pix manual da assinatura (opcional, só sem Stripe) |
| `SALES_EMAIL` | E-mail que recebe os comprovantes (padrão `contato@falaki.me`) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Cria o primeiro administrador ao iniciar |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Credenciais OAuth do Google Cloud para sincronizar o Google Agenda |
| `DB_PATH` | Caminho do banco SQLite (padrão `data/falaki.db`; se só existir o antigo `data/fechou.db`, ele continua sendo usado) |

Cada empresa cadastra a própria chave da Anthropic em Configurações → Integrações (o consumo é cobrado direto na conta dela). No painel `/admin`, o administrador pode marcar uma empresa para usar a chave da plataforma; só ele muda essa opção, e o consumo mensal de tokens dessa empresa aparece na ficha dela.

Sem chave da Anthropic, o atendimento funciona em **modo demonstração** (respostas automáticas simples para preço, horários e "falar com atendente").

## Conectando os serviços

Todas as URLs de webhook aparecem prontas em **Configurações**. Para receber webhooks, o sistema precisa estar num endereço público (servidor, VPS, Railway, Render etc.) com `PUBLIC_URL` configurado.

**WhatsApp**: escolha em Configurações → WhatsApp.
- **Evolution API** (conecta qualquer número por QR Code): informe URL, instância e API key, e aponte o webhook da instância (evento `MESSAGES_UPSERT`) para `/webhooks/whatsapp/evolution/{id}`.
- **WhatsApp Cloud API oficial (Meta)**: informe Phone Number ID, token, verify token e app secret, e cadastre o callback `/webhooks/whatsapp/meta/{id}` assinando `messages`. A Meta só permite iniciar conversa (follow-up, prospecção) fora da janela de 24h com **template aprovado**: cadastre o nome do template (com 1 variável = nome do cliente).

**Cobrança**: em Configurações → Cobrança.
- **Pix próprio**: só a chave, nome e cidade. Gera Pix copia e cola com valor; a baixa é manual (botão "Recebido").
- **Asaas**: API key + token do webhook (`/webhooks/billing/asaas/{id}`). Gera link com Pix, boleto e cartão; baixa automática. O Asaas exige CPF/CNPJ no contato.
- **Mercado Pago**: access token. Gera link de pagamento; a confirmação é consultada na API do Mercado Pago antes da baixa.

**Prospecção**: ative a *Places API (New)* no Google Cloud e cole a chave em Configurações → Integrações.

## Como as automações funcionam

Um agendador interno roda a cada minuto (`SCHEDULER_INTERVAL_MS`) e:
1. envia os passos de follow-up vencidos (só em horário comercial);
2. marca cobranças vencidas e envia os lembretes da régua (ex.: D-3, D0, D+1, D+3, D+7), uma vez cada;
3. envia lembretes de agendamento (padrão: 24h antes).

O botão **▶ Executar agora** (tela Follow-up) roda tudo na hora, útil para testar.

A IA aguarda ~2,5s após a última mensagem do cliente antes de responder (quem escreve no WhatsApp costuma mandar várias mensagens seguidas). Quando alguém da equipe responde manualmente, a IA pausa naquela conversa até ser reativada.

## Estrutura

```
src/
  server.js            servidor HTTP + arquivos estáticos
  db.js                esquema SQLite
  auth.js              contas, senhas (scrypt) e sessões
  routes/api.js        API REST do painel
  routes/webhooks.js   WhatsApp (Meta/Evolution) e pagamentos (Asaas/Mercado Pago)
  services/
    ai.js              agente Claude com ferramentas (agendar, cobrar, CRM...)
    messaging.js       envio/recebimento de WhatsApp
    crm.js             contatos, funil e histórico
    scheduling.js      cálculo de horários livres e agendamentos
    followup.js        sequências e execução
    billing.js         Pix (BR Code), gateways e régua de cobrança
    prospecting.js     Google Places
    dashboard.js       métricas
    scheduler.js       automações periódicas
public/                painel web (HTML/CSS/JS, sem build)
test/                  testes (npm test)
```

## Demonstração no navegador

`npm run build:demo` gera `dist/falaki-demo.html`: um único arquivo que roda o próprio código do Falaki no navegador (o SQLite vai compilado para WebAssembly), com duas empresas de exemplo (clínica odontológica e escritório de advocacia) e um seletor para alternar entre elas. O link com `#advocacia` no final abre direto no escritório. Serve para mostrar o sistema a clientes sem instalar nada.

## Testes

```bash
npm test
```

Cobrem fuso horário, Pix (CRC conferido com o exemplo do Banco Central), agenda e conflitos, resposta da IA com uso de ferramentas (cliente simulado), follow-up (envio e parada na resposta), régua de cobrança e baixa, webhooks e isolamento de dados entre empresas.

## Produção

- Rode atrás de HTTPS (Nginx, Caddy ou a plataforma de hospedagem) e defina `PUBLIC_URL`.
- Faça backup do arquivo do banco (`data/falaki.db`).
- Desative cadastros públicos com `ALLOW_SIGNUP=false` se for criar as contas dos clientes manualmente.
- Há um `Dockerfile` pronto: `docker build -t falaki . && docker run -p 3000:3000 -v falaki-data:/app/data falaki`.
