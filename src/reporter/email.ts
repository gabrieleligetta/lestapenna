/**
 * Reporter - Email Logic
 */

import { transporter } from './config';
import { getGuildConfig } from '../db';

/**
 * Helper per ottenere la lista dei destinatari
 * Prima cerca nella config per-guild, poi fallback su variabili d'ambiente
 */
export function getRecipients(envVarName: string, guildId?: string): string[] {
    // 1. Cerca config per-guild (es. "report_recipients")
    if (guildId) {
        const guildRecipients = getGuildConfig(guildId, 'report_recipients');
        if (guildRecipients) {
            return parseRecipients(guildRecipients);
        }
    }

    // 2. Fallback su variabili d'ambiente
    const recipientEnv = process.env[envVarName] || process.env.REPORT_RECIPIENT;
    if (!recipientEnv) return ['gabligetta@gmail.com'];

    return parseRecipients(recipientEnv);
}

function parseRecipients(value: string): string[] {
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
            return parsed;
        }
        return [String(parsed)];
    } catch (e) {
        if (value.includes(',')) {
            return value.split(',').map(s => s.trim());
        }
        return [value];
    }
}

export async function sendEmail(
    to: string | string[],
    subject: string,
    text: string,
    html: string,
    attachments: any[] = []
): Promise<boolean> {
    const recipients = Array.isArray(to) ? to.join(', ') : to;
    const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Lestapenna'}" <${process.env.SMTP_USER}>`,
        to: recipients,
        subject: subject,
        text: text,
        html: html,
        attachments: attachments
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[Reporter] 📧 Email inviata a ${recipients}`);
        return true;
    } catch (e) {
        console.error("[Reporter] ❌ Errore invio email:", e);
        return false;
    }
}
