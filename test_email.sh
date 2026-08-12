#!/bin/bash

echo "📧 Preparazione test email..."

# Creiamo un piccolo script JS temporaneo che usa le librerie del progetto
cat << 'EOF' > _temp_mail_test.js
require('dotenv').config();
const nodemailer = require('nodemailer');

async function test() {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '465');
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    // Nessun destinatario di ripiego: un default cablato manderebbe la mail di
    // prova di chiunque alla casella di qualcun altro.
    const to = process.env.REPORT_RECIPIENT;

    if (!host || !user || !pass) {
        console.error("❌ Errore: Variabili SMTP mancanti nel file .env");
        process.exitCode = 1;
        return;
    }

    if (!to) {
        console.error("❌ Errore: REPORT_RECIPIENT non impostato. È il destinatario della mail di prova.");
        process.exitCode = 1;
        return;
    }

    console.log(`⚙️  Configurazione rilevata:
    - Host: ${host}
    - Port: ${port}
    - User: ${user}
    - Dest: ${to}
    `);

    const transporter = nodemailer.createTransport({
        host: host,
        port: port,
        secure: port === 465, // True per 465 (Implicit TLS)
        auth: { user, pass }
    });

    try {
        console.log("⏳ Tentativo di connessione e invio...");
        const info = await transporter.sendMail({
            from: `"${process.env.SMTP_FROM_NAME || 'Test Script'}" <${user}>`,
            to: to,
            subject: "Test Script Shell - Lestapenna",
            text: "Ciao! Se leggi questo messaggio, la configurazione SMTP nel file .env è corretta e funzionante."
        });
        console.log("✅ Email inviata con successo!");
        console.log("🆔 Message ID:", info.messageId);
    } catch (error) {
        console.error("❌ Errore durante l'invio:");
        console.error(error);
    }
}

test();
EOF

# Eseguiamo lo script con Node
node _temp_mail_test.js

# Pulizia
rm _temp_mail_test.js
