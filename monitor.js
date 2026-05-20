require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const nodemailer = require("nodemailer");
const { chromium } = require("playwright");

const DEBUG = process.argv.includes("--debug");

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variavel obrigatoria ausente: ${name}`);
  }
  return value;
}

function boolFromEnv(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "sim"].includes(String(value).trim().toLowerCase());
}

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return { lastSignature: null, lastPendingCount: 0, lastNotifiedAt: null };
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (error) {
    log(`Falha ao ler estado anterior, seguindo com estado vazio: ${error.message}`);
    return { lastSignature: null, lastPendingCount: 0, lastNotifiedAt: null };
  }
}

function saveState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

function buildSignature(rows) {
  return rows
    .map((row) => [row.solicitacao, row.regional, row.planoInterno, row.ptres, row.dataSolicitacao, row.valorTotal].join("|"))
    .join("||");
}

function formatRows(rows) {
  return rows
    .slice(0, 10)
    .map((row, index) => {
      const parts = [
        `${index + 1}. Solicitação ${row.solicitacao || "-"}`,
        `Regional ${row.regional || "-"}`,
        `Plano Interno ${row.planoInterno || "-"}`,
        `PTRES ${row.ptres || "-"}`,
        `Data ${row.dataSolicitacao || "-"}`,
        `Valor ${row.valorTotal || "-"}`
      ];
      if (row.descricao) {
        parts.push(`Descrição ${row.descricao}`);
      }
      if (row.favorecido) {
        parts.push(`Favorecido ${row.favorecido}`);
      }
      return parts.join(" | ");
    })
    .join("\n");
}

async function sendEmail(subject, body) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.EMAIL_TO;
  const from = process.env.EMAIL_FROM || user;

  if (!host || !user || !pass || !to || !from) {
    log("Configuracao de e-mail incompleta. Alerta por e-mail ignorado.");
    return false;
  }

  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: boolFromEnv(process.env.SMTP_SECURE, false),
    auth: { user, pass }
  });

  await transporter.sendMail({
    from,
    to,
    subject,
    text: body
  });

  log("E-mail enviado com sucesso.");
  return true;
}

async function sendTelegram(body) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    log("Configuracao de Telegram incompleta. Alerta por Telegram ignorado.");
    return false;
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: body
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Falha ao enviar Telegram: ${response.status} ${detail}`);
  }

  log("Telegram enviado com sucesso.");
  return true;
}

async function notifyAll(subject, body) {
  const attempts = [
    { channel: "e-mail", send: () => sendEmail(subject, body) },
    { channel: "Telegram", send: () => sendTelegram(body) }
  ];

  const results = await Promise.allSettled(
    attempts.map(async ({ channel, send }) => ({
      channel,
      sent: await send()
    }))
  );

  const successful = [];
  const failures = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      if (result.value.sent) {
        successful.push(result.value.channel);
      }
      continue;
    }

    failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      log(failure);
    }
  }

  if (successful.length === 0) {
    log("Nenhum canal de notificacao enviou mensagem.");
  } else {
    log(`Notificacao enviada por: ${successful.join(", ")}.`);
  }
}

async function fetchPendingApprovals(config) {
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });

    await page.locator('input[placeholder="CPF"]:visible').fill(config.cpf, { timeout: config.timeoutMs });
    await page.locator('input[placeholder="Senha"]:visible').fill(config.password, { timeout: config.timeoutMs });

    await Promise.all([
      page.waitForURL(/\/consiafipro\/?$/, { timeout: config.timeoutMs }),
      page.getByRole("button", { name: "Entrar", exact: true }).click({ timeout: config.timeoutMs })
    ]);

    await page.goto(config.approvalUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
    await page.getByRole("heading", { name: "Lista de Solicitações de Programação Orçamentária Pendentes de Análise", exact: true }).waitFor({
      state: "visible",
      timeout: config.timeoutMs
    });

    await page.waitForTimeout(1500);

    const result = await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll("h4"))
        .map((el) => (el.textContent || "").trim())
        .find((text) => text.includes("Pendentes de Análise")) || "";

      const statusText = Array.from(document.querySelectorAll("*"))
        .map((el) => (el.textContent || "").trim())
        .find((text) => /^Mostrando\s+\d+\s+até\s+\d+\s+de\s+\d+\s+registros$/i.test(text)) || "";

      const rows = Array.from(document.querySelectorAll("table tbody tr")).map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent || "").trim().replace(/\s+/g, " "))
      );

      const visibleRows = rows
        .filter((cells) => cells.length > 0)
        .filter((cells) => !cells.some((cell) => /Nenhum registro encontrado/i.test(cell)))
        .map((cells) => ({
          indice: cells[0] || "",
          solicitacao: cells[1] || "",
          regional: cells[2] || "",
          planoInterno: cells[3] || "",
          ptres: cells[4] || "",
          favorecido: cells[5] || "",
          descricao: cells[6] || "",
          dataSolicitacao: cells[7] || "",
          valorTotal: cells[8] || ""
        }));

      return {
        heading,
        statusText,
        pendingCount: visibleRows.length,
        rows: visibleRows
      };
    });

    if (DEBUG) {
      log(`Resultado bruto: ${JSON.stringify(result, null, 2)}`);
    }

    return result;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const config = {
    loginUrl: process.env.CONSIAFI_LOGIN_URL || "https://consiafi.icmbio.gov.br/consiafipro/login",
    approvalUrl: process.env.CONSIAFI_APPROVAL_URL || "https://consiafi.icmbio.gov.br/consiafipro/planejamento/aprovacao",
    cpf: required("CONSIAFI_CPF"),
    password: required("CONSIAFI_PASSWORD"),
    headless: boolFromEnv(process.env.HEADLESS, true),
    timeoutMs: Number(process.env.TIMEOUT_MS || 45000),
    stateFile: path.resolve(process.cwd(), process.env.STATE_FILE || "monitor-state.json")
  };

  const state = loadState(config.stateFile);
  const result = await fetchPendingApprovals(config);
  const signature = buildSignature(result.rows);
  const hasChange = signature !== state.lastSignature;
  const shouldNotify = result.pendingCount > 0 && (state.lastPendingCount === 0 || hasChange);

  log(`Consulta concluida. Pendencias encontradas: ${result.pendingCount}.`);

  if (shouldNotify) {
    const subject = `[CONSIAFI] ${result.pendingCount} solicitacao(oes) pendente(s) para aprovacao`;
    const body = [
      "Foram encontradas solicitacoes pendentes de aprovacao de programacao no CONSIAFI.",
      "",
      `Quantidade: ${result.pendingCount}`,
      result.statusText ? `Resumo da tabela: ${result.statusText}` : "",
      "",
      formatRows(result.rows),
      "",
      `Consulta realizada em: ${new Date().toLocaleString("pt-BR")}`
    ]
      .filter(Boolean)
      .join("\n");

    await notifyAll(subject, body);
  } else if (result.pendingCount === 0) {
    log("Nenhuma pendencia encontrada. Nenhum alerta foi enviado.");
  } else {
    log("Ainda existem pendencias, mas sem alteracao desde o ultimo alerta.");
  }

  saveState(config.stateFile, {
    lastSignature: signature,
    lastPendingCount: result.pendingCount,
    lastNotifiedAt: shouldNotify ? new Date().toISOString() : state.lastNotifiedAt
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
