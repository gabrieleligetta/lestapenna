/**
 * Reporter - Email Logic
 */

import { transporter } from './config';
import { getGuildConfig, recordingRepository, characterRepository } from '../db';
import { config } from '../config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * No fallback recipient written into the source.
 *
 * There used to be one, and it was a personal address: it meant that every
 * Lestapenna instance in the world, if left unconfigured, shipped its session
 * reports — that is, the account of strangers' game night — to a mailbox that
 * had nothing to do with it. An instance with no configured recipient sends
 * nothing, and that is the only correct answer.
 */
const NO_RECIPIENTS: string[] = [];

/**
 * Helper that returns the recipient list for SESSION REPORTS.
 * Combines: guild email ($setemail) + individual player emails (from $sono).
 * Uses a Set to deduplicate (avoids a double send when the same address is in both).
 */
export function getRecipients(envVarName: string, guildId?: string, sessionId?: string, campaignId?: number): string[] {
    const emails = new Set<string>();

    // 1. Addresses configured for the server ($setemail)
    if (guildId) {
        const guildRecipients = getGuildConfig(guildId, 'report_recipients');
        if (guildRecipients) {
            parseRecipients(guildRecipients).forEach(e => emails.add(e.toLowerCase()));
        }
    }

    // 2. Individual emails of the session's players
    if (sessionId && campaignId) {
        try {
            const recordings = recordingRepository.getSessionRecordings(sessionId);
            const userIds = [...new Set(recordings.map(r => r.user_id).filter(Boolean))];

            for (const userId of userIds) {
                const profile = characterRepository.getUserProfile(userId, campaignId);
                if (profile.email) {
                    emails.add(profile.email.toLowerCase());
                }
            }
        } catch (e) {
            console.error('[Reporter] Errore recupero email giocatori:', e);
        }
    }

    // 3. If we have addresses, return them
    if (emails.size > 0) {
        return [...emails];
    }

    // 4. Fallback su variabili d'ambiente
    const recipientEnv = process.env[envVarName] || process.env.REPORT_RECIPIENT;
    if (!recipientEnv) return NO_RECIPIENTS;

    return parseRecipients(recipientEnv);
}

/**
 * Helper that returns the recipients of TECHNICAL REPORTS
 * These go ONLY to the server admin (or to the global developer)
 */
export function getTechnicalRecipients(guildId?: string): string[] {
    // Technical reports go only to the developer/admin, not to everyone
    // For now we only use the global developer's email
    // In the future a per-guild 'admin_email' config could be added
    const technicalEnv = process.env.TECHNICAL_REPORT_RECIPIENT;
    if (technicalEnv) {
        return parseRecipients(technicalEnv);
    }
    return NO_RECIPIENTS;
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
    // Having no recipient is a legitimate configuration — an instance that
    // sends no mail — not an error to hand to nodemailer just to be told no.
    // Since there is no fallback address in the source any more, it is also
    // the normal case for anyone self-hosting without SMTP.
    if (!recipients.trim()) return false;

    const mailOptions = {
        from: `"${process.env.SMTP_FROM_NAME || 'Lestapenna'}" <${process.env.SMTP_USER}>`,
        to: recipients,
        subject: subject,
        text: text,
        html: html,
        attachments: attachments
    };

    try {
        if (process.env.EMAIL_DRY_RUN === 'true') {
            const outDir = process.env.EMAIL_DRY_RUN_DIR || path.join(process.cwd(), 'tmp', 'email_dry_run');
            fs.mkdirSync(outDir, { recursive: true });
            const outPath = path.join(outDir, `email_${Date.now()}.json`);
            fs.writeFileSync(outPath, JSON.stringify(mailOptions, null, 2), 'utf-8');
            console.log(`[Reporter] 📧 Email dry-run salvata: ${outPath}`);
            return true;
        }

        await transporter.sendMail(mailOptions);
        console.log(`[Reporter] 📧 Email inviata a ${recipients}`);
        return true;
    } catch (e) {
        console.error("[Reporter] ❌ Errore invio email:", e);
        return false;
    }
}
