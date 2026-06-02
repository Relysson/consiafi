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
    return {
      consiafi: { lastSignature: null, lastPendingCount: 0, lastNotifiedAt: null },
      sei: { lastSignature: null, lastAssignedCount: 0, lastNotifiedAt: null }
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      consiafi: {
        lastSignature: parsed?.consiafi?.lastSignature ?? parsed?.lastSignature ?? null,
        lastPendingCount: parsed?.consiafi?.lastPendingCount ?? parsed?.lastPendingCount ?? 0,
        lastNotifiedAt: parsed?.consiafi?.lastNotifiedAt ?? parsed?.lastNotifiedAt ?? null
      },
      sei: {
        lastSignature: parsed?.sei?.lastSignature ?? null,
        lastAssignedCount: parsed?.sei?.lastAssignedCount ?? 0,
        lastNotifiedAt: parsed?.sei?.lastNotifiedAt ?? null
      }
    };
  } catch (error) {
    log(`Falha ao ler estado anterior, seguindo com estado vazio: ${error.message}`);
    return {
      consiafi: { lastSignature: null, lastPendingCount: 0, lastNotifiedAt: null },
      sei: { lastSignature: null, lastAssignedCount: 0, lastNotifiedAt: null }
    };
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

function formatSeiProcesses(processes) {
  return processes
    .slice(0, 20)
    .map((processNumber, index) => `${index + 1}. ${processNumber}`)
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
  const browser = await chromium.launch({
    headless: config.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"]
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  try {
    await page.goto(config.loginUrl, { waitUntil: "networkidle", timeout: config.timeoutMs });
    await page.waitForTimeout(2000);

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

async function fetchSeiAssignedProcesses(config) {
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(config.seiLoginUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });

    await page.getByRole("textbox", { name: "Usuário", exact: true }).fill(config.seiUser, { timeout: config.timeoutMs });
    await page.getByRole("textbox", { name: "Senha", exact: true }).fill(config.seiPassword, { timeout: config.timeoutMs });

    await Promise.all([
      page.waitForURL(/controlador\.php\?acao=procedimento_controlar/i, { timeout: config.timeoutMs }),
      page.getByRole("button", { name: "ACESSAR", exact: true }).click({ timeout: config.timeoutMs })
    ]);

    await page.waitForLoadState("domcontentloaded", { timeout: config.timeoutMs });
    await page.waitForTimeout(1500);

    const result = await page.evaluate((seiUser) => {
      const normalizedUser = String(seiUser || "").replace(/\D/g, "");
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      const processes = rows
        .map((row) => {
          const cells = Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent || "").trim().replace(/\s+/g, " "));
          if (cells.length < 4) {
            return null;
          }

          const processNumber = cells[2] || "";
          const assignedRaw = cells[3] || "";
          const assignedUser = assignedRaw.replace(/\D/g, "");

          if (!processNumber || !assignedUser) {
            return null;
          }

          return { processNumber, assignedUser };
        })
        .filter(Boolean)
        .filter((item) => item.assignedUser === normalizedUser)
        .map((item) => item.processNumber);

      return {
        assignedCount: processes.length,
        processes
      };
    }, config.seiUser);

    if (DEBUG) {
      log(`Resultado bruto SEI: ${JSON.stringify(result, null, 2)}`);
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
    seiLoginUrl: process.env.SEI_LOGIN_URL || "https://sei.icmbio.gov.br/sip/login.php?sigla_orgao_sistema=ICMBio&sigla_sistema=SEI",
    seiUser: required("SEI_USER"),
    seiPassword: required("SEI_PASSWORD"),
    headless: boolFromEnv(process.env.HEADLESS, true),
    timeoutMs: Number(process.env.TIMEOUT_MS || 45000),
    stateFile: path.resolve(process.cwd(), process.env.STATE_FILE || "monitor-state.json")
  };

  const state = loadState(config.stateFile);

  let consiafiResult = { pendingCount: 0, rows: [], statusText: "" };
  let consiafiError = null;
  try {
    consiafiResult = await fetchPendingApprovals(config);
    log(`Consulta CONSIAFI concluida. Pendencias encontradas: ${consiafiResult.pendingCount}.`);
  } catch (err) {
    consiafiError = err.message || String(err);
    log(`Consulta CONSIAFI falhou: ${consiafiError}`);
  }

  let seiResult = { assignedCount: 0, processes: [] };
  let seiError = null;
  try {
    seiResult = await fetchSeiAssignedProcesses(config);
    log(`Consulta SEI concluida. Processos atribuidos a voce: ${seiResult.assignedCount}.`);
  } catch (err) {
    seiError = err.message || String(err);
    log(`Consulta SEI falhou: ${seiError}`);
  }

  if (consiafiError && seiError) {
    throw new Error(`Ambas as consultas falharam.\nCONSIAFI: ${consiafiError}\nSEI: ${seiError}`);
  }

  const consiafiSignature = buildSignature(consiafiResult.rows);
  const consiafiHasChange = consiafiSignature !== state.consiafi.lastSignature;
  const shouldNotifyConsiafi = consiafiResult.pendingCount > 0 && (state.consiafi.lastPendingCount === 0 || consiafiHasChange);

  const seiSignature = seiResult.processes.join("||");
  const seiHasChange = seiSignature !== state.sei.lastSignature;
  const shouldNotifySei = seiResult.assignedCount > 0 && (state.sei.lastAssignedCount === 0 || seiHasChange);

  const shouldNotify = shouldNotifyConsiafi || shouldNotifySei;

  if (shouldNotify) {
    const subjectParts = [];
    if (consiafiResult.pendingCount > 0) {
      subjectParts.push(`CONSIAFI ${consiafiResult.pendingCount} pendencia(s)`);
    }
    if (seiResult.assignedCount > 0) {
      subjectParts.push(`SEI ${seiResult.assignedCount} processo(s)`);
    }

    const subject = `[Monitor] ${subjectParts.join(" | ")}`;
    const body = [
      "Resumo automatico das consultas.",
      "",
      "CONSIAFI",
      consiafiError ? `ERRO na consulta: ${consiafiError}` : `Pendencias de aprovacao: ${consiafiResult.pendingCount}`,
      !consiafiError && consiafiResult.statusText ? `Resumo da tabela: ${consiafiResult.statusText}` : "",
      !consiafiError && (consiafiResult.pendingCount > 0 ? formatRows(consiafiResult.rows) : "Nenhuma pendencia encontrada."),
      "",
      "SEI",
      seiError ? `ERRO na consulta: ${seiError}` : `Processos atribuidos a mim: ${seiResult.assignedCount}`,
      !seiError && (seiResult.assignedCount > 0 ? formatSeiProcesses(seiResult.processes) : "Nenhum processo atribuido a voce."),
      "",
      `Consulta realizada em: ${new Date().toLocaleString("pt-BR")}`
    ]
      .filter(Boolean)
      .join("\n");

    await notifyAll(subject, body);
  } else {
    log("Sem novidades para notificar nos sistemas monitorados.");
  }

  saveState(config.stateFile, {
    consiafi: {
      lastSignature: consiafiSignature,
      lastPendingCount: consiafiResult.pendingCount,
      lastNotifiedAt: shouldNotifyConsiafi ? new Date().toISOString() : state.consiafi.lastNotifiedAt
    },
    sei: {
      lastSignature: seiSignature,
      lastAssignedCount: seiResult.assignedCount,
      lastNotifiedAt: shouldNotifySei ? new Date().toISOString() : state.sei.lastNotifiedAt
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
