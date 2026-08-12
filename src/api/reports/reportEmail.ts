import { getTechnicalRecipients, sendEmail } from '../../reporter/email';
import { logger } from '../../utils/logger';

const log = logger('ReportEmail');

export interface ReportEmailInput {
    number: number;
    id: string;
    createdAt: number;
    type: string;
    severity: string;
    description: string;
    steps?: string | null;
    url?: string | null;
    locale?: string | null;
    theme?: string | null;
    viewport?: { width: number; height: number } | null;
    userAgent?: string | null;
    campaignId?: number | null;
    guildId?: string | null;
    appVersion?: string | null;
    reporter: { discordId: string; username: string; globalName: string | null };
    origin: string;
    screenshot?: { buffer: Buffer; mimetype: string; filename: string } | null;
}

const TYPE_COLORS: Record<string, string> = {
    BUG: '#dc2626',
    UI: '#7c3aed',
    UX: '#7c3aed',
    DATA: '#2563eb',
    FLOW: '#0891b2',
    PERFORMANCE: '#d97706',
    SECURITY: '#991b1b',
    CONTENT: '#65a30d',
    FEATURE: '#4f46e5',
    OTHER: '#6b7280',
};

const SEVERITY_LABEL: Record<string, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    critical: 'Critical',
};

function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatTimestamp(ms: number): string {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function contextRows(input: ReportEmailInput): string {
    const rows: Array<[string, string]> = [
        ['Origin', input.origin],
        ['URL', input.url ?? '—'],
        ['Guild', input.guildId ?? '—'],
        ['Campaign', input.campaignId != null ? String(input.campaignId) : '—'],
        ['Locale', input.locale ?? '—'],
        ['Theme', input.theme ?? '—'],
        ['Viewport', input.viewport ? `${input.viewport.width}×${input.viewport.height}` : '—'],
        ['App version', input.appVersion ?? '—'],
        ['User agent', input.userAgent ?? '—'],
    ];
    return rows
        .map(
            ([label, value]) =>
                `<tr><td class="k">${escapeHtml(label)}</td><td class="v">${escapeHtml(value)}</td></tr>`,
        )
        .join('');
}

/** Build a well-formatted HTML/text email for a freshly created report. */
export function buildReportEmail(input: ReportEmailInput): {
    subject: string;
    text: string;
    html: string;
    attachments: Array<{ filename: string; content: Buffer; cid: string; contentType: string }>;
} {
    const typeColor = TYPE_COLORS[input.type] ?? '#6b7280';
    const severityLabel = SEVERITY_LABEL[input.severity] ?? input.severity;
    const hasScreenshot = Boolean(input.screenshot);
    const attachments = hasScreenshot
        ? [
              {
                  filename: input.screenshot!.filename || 'screenshot',
                  content: input.screenshot!.buffer,
                  cid: 'report-screenshot@lestapenna',
                  contentType: input.screenshot!.mimetype,
              },
          ]
        : [];

    const subject = `[Lestapenna Report #${input.id}] ${input.type} — ${input.severity.toUpperCase()}`;

    const text =
        `Lestapenna report #${input.id}\n` +
        `Type: ${input.type}  |  Severity: ${severityLabel}  |  Origin: ${input.origin}\n` +
        `Created: ${formatTimestamp(input.createdAt)}\n` +
        `Reporter: ${input.reporter.globalName ?? input.reporter.username} (${input.reporter.discordId})\n\n` +
        `URL: ${input.url ?? '—'}\n` +
        `Guild: ${input.guildId ?? '—'}  |  Campaign: ${input.campaignId ?? '—'}\n` +
        `Locale: ${input.locale ?? '—'}  |  Theme: ${input.theme ?? '—'}  |  Viewport: ${input.viewport ? `${input.viewport.width}x${input.viewport.height}` : '—'}\n` +
        `App version: ${input.appVersion ?? '—'}\n` +
        `User agent: ${input.userAgent ?? '—'}\n\n` +
        `--- Description ---\n${input.description}\n\n` +
        (input.steps ? `--- Steps to reproduce ---\n${input.steps}\n\n` : '') +
        (hasScreenshot ? `Screenshot: see attachment (${input.screenshot!.filename}).\n` : '');

    const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1a2e;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2f7;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e6e2ee;border-radius:12px;overflow:hidden;max-width:600px;">
        <tr><td style="padding:24px 28px;background:linear-gradient(135deg,#2a1f3d,#201828);">
          <div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#c9b8e6;">Lestapenna · Segnalazione</div>
          <div style="font-size:22px;font-weight:600;color:#ffffff;margin-top:6px;">Report #${escapeHtml(input.id)}</div>
          <div style="margin-top:10px;">
            <span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;background:${typeColor};">${escapeHtml(input.type)}</span>
            <span style="display:inline-block;margin-left:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:#1f1a2e;background:#ede7fb;">Severity: ${escapeHtml(severityLabel)}</span>
            <span style="display:inline-block;margin-left:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;background:#6b7280;">${escapeHtml(input.origin)}</span>
          </div>
          <div style="font-size:12px;color:#a99fc4;margin-top:10px;">${escapeHtml(formatTimestamp(input.createdAt))}</div>
        </td></tr>

        <tr><td style="padding:20px 28px 4px;">
          <div style="font-size:13px;font-weight:600;color:#7c6a9a;text-transform:uppercase;letter-spacing:.08em;">Description</div>
          <div style="font-size:15px;line-height:1.5;color:#1f1a2e;margin-top:6px;white-space:pre-wrap;">${escapeHtml(input.description)}</div>
        </td></tr>

        ${input.steps ? `<tr><td style="padding:16px 28px 4px;"><div style="font-size:13px;font-weight:600;color:#7c6a9a;text-transform:uppercase;letter-spacing:.08em;">Steps to reproduce</div><div style="font-size:14px;line-height:1.5;color:#3a3350;margin-top:6px;white-space:pre-wrap;">${escapeHtml(input.steps)}</div></td></tr>` : ''}

        <tr><td style="padding:16px 28px 4px;">
          <div style="font-size:13px;font-weight:600;color:#7c6a9a;text-transform:uppercase;letter-spacing:.08em;">Context</div>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-top:8px;border-collapse:collapse;font-size:13px;">
            ${contextRows(input)}
          </table>
        </td></tr>

        <tr><td style="padding:16px 28px 4px;">
          <div style="font-size:13px;font-weight:600;color:#7c6a9a;text-transform:uppercase;letter-spacing:.08em;">Reporter</div>
          <div style="font-size:13px;color:#3a3350;margin-top:6px;">${escapeHtml(input.reporter.globalName ?? input.reporter.username)} · <code style="font-size:12px;color:#6b5b8e;">${escapeHtml(input.reporter.discordId)}</code></div>
        </td></tr>

        ${
            hasScreenshot
                ? `<tr><td style="padding:16px 28px 24px;"><div style="font-size:13px;font-weight:600;color:#7c6a9a;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">Screenshot</div><img src="cid:report-screenshot@lestapenna" alt="Screenshot" style="max-width:100%;border:1px solid #e6e2ee;border-radius:8px;"/></td></tr>`
                : '<tr><td style="padding:8px 28px 24px;"></td></tr>'
        }
      </table>
      <div style="font-size:11px;color:#9a90b0;margin-top:10px;">Inviato automaticamente dal pulsante "Segnala" di Lestapenna.</div>
    </td></tr>
  </table>
</body>
</html>`;

    return { subject, text, html, attachments };
}

/** Best-effort: send the report email to TECHNICAL_REPORT_RECIPIENT. Never throws. */
export async function sendReportEmail(input: ReportEmailInput): Promise<void> {
    try {
        const recipients = getTechnicalRecipients();
        const { subject, text, html, attachments } = buildReportEmail(input);
        const ok = await sendEmail(recipients, subject, text, html, attachments);
        if (!ok) log.warn(`Report #${input.id} email delivery reported failure (report still persisted).`);
    } catch (error) {
        log.error(`Failed to send report #${input.id} email`, error as Error);
    }
}