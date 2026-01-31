/**
 * Reporter - Email Logic
 */

import { transporter } from './config';
import { getGuildConfig } from '../db';
import { config } from '../config';

const DEFAULT_DEVELOPER_EMAIL = 'gabligetta@gmail.com';

/**
 * Helper per ottenere la lista dei destinatari per i REPORT DI SESSIONE
 * Prima cerca nella config per-guild ($setemail), poi fallback su variabili d'ambiente
 */
export function getRecipients(envVarName: string, guildId?: string): string[] {
    // 1. Cerca config per-guild (impostata con $setemail)
    if (guildId) {
        const guildRecipients = getGuildConfig(guildId, 'report_recipients');
        if (guildRecipients) {
            return parseRecipients(guildRecipients);
        }
    }

    // 2. Fallback su variabili d'ambiente
    const recipientEnv = process.env[envVarName] || process.env.REPORT_RECIPIENT;
    if (!recipientEnv) return [DEFAULT_DEVELOPER_EMAIL];

    return parseRecipients(recipientEnv);
}

/**
 * Helper per ottenere i destinatari dei REPORT TECNICI
 * Vanno SOLO all'admin del server (o al developer globale)
 */
export function getTechnicalRecipients(guildId?: string): string[] {
    // I report tecnici vanno solo al developer/admin, non a tutti
    // Per ora usiamo solo l'email del developer globale
    // In futuro si potrebbe aggiungere una config per-guild 'admin_email'
    const technicalEnv = process.env.TECHNICAL_REPORT_RECIPIENT;
    if (technicalEnv) {
        return parseRecipients(technicalEnv);
    }
    return [DEFAULT_DEVELOPER_EMAIL];
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
