require("dotenv").config();
const nodemailer = require("nodemailer");

async function main() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.EMAIL_TO;
  const from = process.env.EMAIL_FROM || user;

  if (!host || !user || !pass || !to) {
    throw new Error("Configuracao SMTP incompleta.");
  }

  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user, pass }
  });

  const subject = "[CONSIAFI] TESTE - 1 solicitacao pendente para aprovacao";
  const body = [
    "*** ISTO E UM TESTE DE NOTIFICACAO ***",
    "",
    "Foram encontradas solicitacoes pendentes de aprovacao de programacao no CONSIAFI.",
    "",
    "Quantidade: 1",
    "",
    "1. Solicitacao 2025NE000123 | Regional REBIO | Plano Interno 000001 | PTRES 12345 | Data 20/05/2026 | Valor R$ 15.000,00",
    "",
    "Consulta realizada em: " + new Date().toLocaleString("pt-BR")
  ].join("\n");

  await transporter.sendMail({ from, to, subject, text: body });
  console.log("E-mail de teste enviado com sucesso para:", to);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
