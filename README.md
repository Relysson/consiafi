# Monitor de aprovacao do CONSIAFI

Este projeto consulta a tela de `Aprovacao de Programacao` do CONSIAFI e tambem o painel do SEI para processos atribuidos a voce. O alerta por e-mail inclui os dois resultados quando houver novidade.

Hoje a verificacao esta apontando para a tela:

- `https://consiafi.icmbio.gov.br/consiafipro/planejamento/aprovacao`
- Titulo encontrado: `Lista de Solicitacoes de Programacao Orcamentaria Pendentes de Analise`

## O que o script faz

1. Faz login no CONSIAFI.
2. Abre a tela de aprovacao e lê a grade de solicitacoes pendentes.
3. Faz login no SEI.
4. Lê os processos atribuidos ao seu usuario no controle de processos.
5. Se houver novidade no CONSIAFI ou mudanca nos processos atribuidos do SEI, envia alerta por e-mail e/ou Telegram.
6. Salva um arquivo local de estado para nao repetir alerta da mesma lista a cada consulta.

## Como configurar

1. Instale as dependencias:

```powershell
npm install
```

2. Crie seu arquivo `.env` a partir do exemplo:

```powershell
Copy-Item .env.example .env
```

3. Edite o `.env` e preencha:

- `CONSIAFI_CPF`
- `CONSIAFI_PASSWORD`
- `SEI_USER`
- `SEI_PASSWORD`
- configuracao SMTP para e-mail
- configuracao do bot do Telegram

## Como testar manualmente

```powershell
npm run check:debug
```

Se nao houver pendencias, o log esperado sera algo como:

- `Pendencias encontradas: 0`
- `Nenhuma pendencia encontrada. Nenhum alerta foi enviado.`

## Como deixar automatico no Windows

Depois de testar com sucesso:

```powershell
.\install-task.ps1 -IntervalMinutes 15
```

Isso cria uma tarefa agendada no Windows para rodar a cada 15 minutos.

## Como deixar automatico no GitHub Actions

O workflow ja esta pronto em `.github/workflows/consiafi-monitor.yml`.

Ele foi configurado para rodar em dias uteis, com intervalo de 52 minutos, entre `08:00` e `17:00` no horario de Brasilia.

Como o GitHub Actions usa `UTC`, os horarios do workflow foram gravados em UTC. Em `20/05/2026`, Brasilia esta em `UTC-3`, entao:

- `08:00 BRT` = `11:00 UTC`
- ultima execucao do dia = `16:40 BRT` = `19:40 UTC`

Sequencia configurada:

- `08:00`
- `08:52`
- `09:44`
- `10:36`
- `11:28`
- `12:20`
- `13:12`
- `14:04`
- `14:56`
- `15:48`
- `16:40`

Observacao importante:

- se o fuso horario oficial do Brasil mudar no futuro, sera preciso ajustar os `cron` do workflow
- o GitHub pode atrasar execucoes agendadas em momentos de alta carga

### Secrets que voce precisa criar no GitHub

No repositorio, em `Settings > Secrets and variables > Actions`, crie:

- `CONSIAFI_LOGIN_URL`
- `CONSIAFI_APPROVAL_URL`
- `SEI_LOGIN_URL`
- `SEI_USER`
- `SEI_PASSWORD`
- `CONSIAFI_CPF`
- `CONSIAFI_PASSWORD`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `EMAIL_FROM`
- `EMAIL_TO`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Se quiser, voce pode deixar:

- `CONSIAFI_LOGIN_URL=https://consiafi.icmbio.gov.br/consiafipro/login`
- `CONSIAFI_APPROVAL_URL=https://consiafi.icmbio.gov.br/consiafipro/planejamento/aprovacao`
- `SEI_LOGIN_URL=https://sei.icmbio.gov.br/sip/login.php?sigla_orgao_sistema=ICMBio&sigla_sistema=SEI`

### Estado entre execucoes

O workflow salva o arquivo `.github/state/monitor-state.json` no proprio repositorio para lembrar a ultima lista consultada e nao repetir alerta igual a cada execucao.

## Alertas

### E-mail

Use qualquer SMTP que voce tenha acesso, por exemplo:

- Gmail com senha de app
- Outlook corporativo com SMTP habilitado
- outro provedor SMTP

### Telegram

O script usa a API oficial do bot do Telegram.

Campos necessarios:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Arquivos importantes

- `monitor.js`: automacao principal
- `.env.example`: modelo de configuracao
- `monitor-state.json`: estado local criado apos a primeira execucao
- `install-task.ps1`: cria a tarefa agendada no Windows
- `.github/workflows/consiafi-monitor.yml`: execucao automatica no GitHub Actions
