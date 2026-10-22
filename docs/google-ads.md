# Google Ads: configuração da campanha de clínicas

Guia para colocar as campanhas no ar medindo o que importa (cadastro no teste e clique no WhatsApp de vendas).
Diagnóstico de partida: 45 cliques e 0 cadastros, CTR 5,27% e CPC R$ 0,47. É cedo para concluir (o mínimo é 150 a 200 cliques), mas o CPC baixo indica tráfego amplo demais. Primeiro limpar o tráfego e medir; depois otimizar.

## 1. Medição (fazer antes de gastar mais)

### 1.1 Conversões no Google Ads

Em **Metas → Conversões → Nova ação de conversão → Site**, informe `conversacrm.online` e escolha **Adicionar uma ação de conversão manualmente**:

| Ação | Categoria | Valor | Contagem | Janela | Uso |
|---|---|---|---|---|---|
| Cadastro no teste | Inscrição | Mesmo valor: R$ 30 | Uma | 30 dias | **Principal** (o lance otimiza por ela) |
| Clique no WhatsApp | Contato | Mesmo valor: R$ 10 | Uma | 30 dias | **Secundária** (só observação no início) |

Em cada ação, abra **Configuração da tag → Usar Google tag → Configurar manualmente**. Aparece algo como:

```
send_to: 'AW-123456789/AbCdEfGhIjK'
```

O que vem antes da barra é o ID da conta (`AW-123456789`); o que vem depois é o rótulo da conversão (`AbCdEfGhIjK`).
Não é preciso colar código no site: o `public/track.js` já carrega a tag e dispara as conversões.

### 1.2 Variáveis no Railway

Em **Railway → serviço → Variables**:

```
GOOGLE_ADS_ID=AW-123456789
GOOGLE_ADS_SIGNUP_LABEL=<rótulo da conversão "Cadastro no teste">
GOOGLE_ADS_LEAD_LABEL=<rótulo da conversão "Clique no WhatsApp">
SALES_WHATSAPP=55DDDNUMERO
```

Sem `SALES_WHATSAPP`, os botões "Falar no WhatsApp" levam para o cadastro.

### 1.3 Conferir

1. Abra `https://conversacrm.online/clinicas?gclid=teste` numa janela anônima e aceite os cookies.
2. Use o **Google Tag Assistant** (tagassistant.google.com): deve aparecer a tag `AW-...`.
3. Clique em "Falar no WhatsApp": deve sair `conversion` com o rótulo de lead.
4. Faça um cadastro de teste: deve sair `conversion` com o rótulo de cadastro.
5. Em **/admin → Inteligência**, a visita aparece com origem `google_ads` e na página `/clinicas`.

O status da conversão no Google Ads leva até 24 h para mudar de "Inativa" para "Registrando conversões".

> Limite: só quem aceita os cookies é medido pelo Google (LGPD). A contagem do /admin (ferramenta própria, sem cookies) é a referência para saber quantos cadastros vieram de anúncio; o Google Ads verá uma parte deles.

Alternativa sem rótulos: vincular o GA4 ao Google Ads (**Ferramentas → Contas vinculadas → Google Analytics**) e importar os eventos `sign_up` e `generate_lead` como conversões. Não use os dois caminhos para a mesma conversão (conta em dobro).

## 2. Campanha de clínicas (Pesquisa)

### Configurações

- **Tipo:** Pesquisa. Meta: Leads.
- **Redes:** desmarcar **Rede de Display** e **Parceiros de pesquisa**.
- **Locais:** Brasil, opção **Presença: pessoas que estão ou costumam estar nos locais** (não "interesse").
- **Idioma:** português.
- **Orçamento:** R$ 30 a R$ 50 por dia para chegar a 150-200 cliques em 1 a 2 semanas.
- **Lance:** começar em **Maximizar cliques com CPC máximo de R$ 2,50**. Depois de 15 a 30 cadastros em 30 dias, trocar para **Maximizar conversões**.
- **Programação:** segunda a sábado, 7h às 22h (dono de clínica pesquisa fora do horário de atendimento também; ajustar pelo relatório depois).
- **URL final:** `https://conversacrm.online/clinicas`
- **Auto-tagging** ligado (Configurações da conta): é o que manda o `gclid` que o site usa para marcar a origem `google_ads`.
- Opcional, no **Modelo de acompanhamento**: `{lpurl}?utm_source=google_ads&utm_medium=cpc&utm_campaign={campaignid}`

### Grupos de anúncios e palavras-chave

Somente correspondência **de frase** ("...") e **exata** ([...]). Nada de ampla no início.

**Clínica · agenda e atendimento**
```
"sistema de agendamento para clínica"
[sistema de agendamento para clínica]
"agenda online para clínica"
"software para clínica"
"sistema para clínica médica"
"agendamento online consultório"
"secretária virtual para clínica"
"recepcionista virtual"
```

**Odontologia**
```
"agenda online para dentista"
[agenda para dentista]
"sistema para consultório odontológico"
"software para dentista"
"agendamento odontológico"
```

**Estética**
```
"sistema para clínica de estética"
"agenda para clínica de estética"
"software para estética"
```

**WhatsApp para clínicas**
```
"atendimento automático whatsapp clínica"
"whatsapp para clínica"
"chatbot para clínica"
"ia para atendimento clínica"
"confirmação de consulta whatsapp"
"lembrete de consulta whatsapp"
```

### Palavras-chave negativas

Crie uma **lista de palavras-chave negativas** (Ferramentas → Biblioteca compartilhada) e aplique em todas as campanhas. Correspondência de frase:

```
"grátis"
"gratuito"
"gratis"
"free"
"baixar"
"download"
"apk"
"como usar"
"como fazer"
"tutorial"
"curso"
"vaga"
"vagas"
"emprego"
"salário"
"trabalhar"
"whatsapp web"
"whatsapp business download"
"whatsapp grátis"
"crm gratuito"
"login"
"entrar"
"pdf"
"modelo"
"planilha"
"o que é"
"significado"
"faculdade"
"tcc"
"marcar consulta"
"agendar consulta"
"telefone"
"endereço"
"perto de mim"
"sus"
"plano de saúde"
"convênio"
```

As últimas (marcar consulta, telefone, perto de mim, SUS, convênio) cortam **pacientes** procurando atendimento, que é o tráfego mais comum nesse tipo de busca.
Revise toda semana em **Insights e relatórios → Termos de pesquisa** e adicione como negativa tudo o que não for dono ou gestor de clínica.

### Anúncio responsivo (RSA)

Títulos (até 30 caracteres). Fixe o 1º na posição 1:

```
Recepcionista IA p/ Clínicas
IA Que Agenda no WhatsApp
Atende, Agenda e Cobra o Sinal
Menos Faltas na Sua Clínica
Lembrete na Véspera Automático
Sinal por Pix ao Agendar
7 Dias Grátis, Sem Cartão
Agenda por Profissional
Atende Pacientes 24h
Para Dentistas e Clínicas
Sem Custo por Mensagem
A IA Nunca Dá Diagnóstico
Pronto em Uma Tarde
Planos a Partir de R$ 49,90
Conversa CRM para Clínicas
```

Descrições (até 90 caracteres):

```
A IA responde o paciente no WhatsApp, marca com o profissional certo e lembra na véspera.
Cobra o sinal por Pix na hora de reservar. Menos falta, mais agenda cheia.
Usa o WhatsApp que a clínica já tem, lendo um QR Code. Sem API oficial e sem cartão.
Odontologia, estética, fisioterapia, psicologia e nutrição. Teste 7 dias grátis.
```

Caminho de exibição: `conversacrm.online/clinicas/agenda`

### Recursos (extensões)

- **Sitelinks:** "Ver planos" → `/clinicas#planos`; "Menos faltas" → `/clinicas#faltas`; "Especialidades" → `/clinicas#especialidades`; "Dúvidas" → `/clinicas#duvidas`.
- **Frases de destaque:** "7 dias grátis", "Sem cartão de crédito", "Sinal por Pix", "Lembrete na véspera", "Agenda por profissional", "Sem custo por mensagem".
- **Snippet estruturado (Tipos):** Odontologia, Estética, Fisioterapia, Psicologia, Nutrição, Dermatologia.
- **Ligação/WhatsApp:** adicionar o número de vendas como recurso de mensagem, se disponível na conta.

## 3. Rotina

**Diária (primeira semana):** Termos de pesquisa → negativar o que não é cliente.

**Semanal:**
- /admin → Inteligência: visitas de `/clinicas` com origem `google_ads`, cliques em "Testar grátis", cadastros abertos e concluídos.
- Google Ads: CTR, CPC médio, conversões, parcela de impressões perdida por orçamento.
- Palavras com mais de 30 cliques e nenhum cadastro nem clique no WhatsApp: pausar.

**Quando decidir:**
- Com 150-200 cliques: se a taxa de cadastro for menor que 2%, o problema é a página ou a oferta (não o anúncio). Olhe no /admin onde as pessoas param (rolagem, tempo, seções).
- Com 15-30 cadastros em 30 dias: trocar o lance para Maximizar conversões.
- O teste A/B/C da página inicial não recebe esse tráfego: o anúncio vai direto para `/clinicas`. Não decida o A/B/C com volume baixo.
