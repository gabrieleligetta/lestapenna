/**
 * Reporter - Email Logic
 */

import { transporter } from './config';

/**
 * Helper per ottenere la lista dei destinatari
 * Accetta il nome della variabile specifica, con fallback su REPORT_RECIPIENT
 */
export function getRecipients(envVarName: string): string[] {
    const recipientEnv = process.env[envVarName] || process.env.REPORT_RECIPIENT;

    if (!recipientEnv) return ['gabligetta@gmail.com'];

    try {
        const parsed = JSON.parse(recipientEnv);
        if (Array.isArray(parsed)) {
            return parsed;
        }
        return [String(parsed)];
    } catch (e) {
        if (recipientEnv.includes(',')) {
            return recipientEnv.split(',').map(s => s.trim());
        }
        return [recipientEnv];
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
