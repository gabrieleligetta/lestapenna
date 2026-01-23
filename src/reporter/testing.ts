/**
 * Reporter - Testing Utilities
 */

import { transporter } from './config';
import axios from "axios";

export async function sendTestEmail(recipient: string): Promise<boolean> {
    const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Lestapenna'}" <${process.env.SMTP_USER}>`,
        to: recipient,
        subject: `[Lestapenna] Test Configurazione SMTP`,
        text: `Test OK.`,
        html: `<h2>Test OK</h2><p>Il sistema di notifica funziona correttamente.</p>`
    };
    try {
        await transporter.sendMail(mailOptions);
        return true;
    } catch (e) {
        return false;
    }
}

export async function testRemoteConnection() {
    const REMOTE_WHISPER_URL = process.env.REMOTE_WHISPER_URL;
    if (!REMOTE_WHISPER_URL) return;

    const healthUrl = `${REMOTE_WHISPER_URL}/health`;

    console.log(`[System] 📡 Test connessione PC remoto (${healthUrl})...`);
    try {
        await axios.get(healthUrl, { timeout: 3000 });
        console.log(`[System] ✅ PC remoto ONLINE e raggiungibile.`);
    } catch (error: any) {
        if (error.response) {
            console.log(`[System] ✅ PC remoto ONLINE (risposta HTTP ${error.response.status}).`);
        } else {
            console.warn(`[System] ⚠️ PC remoto NON RAGGIUNGIBILE: ${error.message}`);
        }
    }
}
