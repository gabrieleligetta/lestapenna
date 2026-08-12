import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { config } from '../../config';
import { ReportsStorage } from '../../services/reportsStorage';
import { transformImageVariants } from '../../utils/imageTransform';
import {
    REPORT_SEVERITIES,
    REPORT_TYPES,
    type ReportSeverity,
    type ReportStatus,
    type ReportType,
} from './dto/report.dto';

const REPORTS_PREFIX = 'reports/';
const INDEX_KEY = 'reports/index.json';
const MAX_DESCRIPTION = 4000;
const MAX_STEPS = 2000;
const MAX_URL = 500;
const MAX_USER_AGENT = 500;
const MAX_APP_VERSION = 64;
const TITLE_MAX = 80;

export interface ReportContextInput {
    type?: string;
    description?: string;
    severity?: string;
    stepsToReproduce?: string;
    screenshot?: Buffer;
    url?: string;
    locale?: string;
    theme?: string;
    viewportWidth?: number;
    viewportHeight?: number;
    userAgent?: string;
    campaignId?: number;
    guildId?: string;
    appVersion?: string;
    reporter: { discordUserId: string; username: string; globalName: string | null };
}

export interface CreatedReport {
    number: number;
    id: string;
    status: ReportStatus;
    createdAt: number;
}

interface StoredScreenshot {
    objectKey: string;
    thumbnailKey: string;
    hasThumbnail: true;
}

interface StatusHistoryEntry {
    status: ReportStatus;
    at: number;
    by: 'user';
    note: string;
}

interface StoredReport {
    number: number;
    id: string;
    status: ReportStatus;
    type: ReportType;
    severity: ReportSeverity;
    title: string;
    description: string;
    stepsToReproduce: string | null;
    screenshot: StoredScreenshot | null;
    reporter: { discordId: string; username: string; globalName: string | null };
    context: {
        origin: string;
        url: string | null;
        campaignId: number | null;
        guildId: string | null;
        locale: string | null;
        theme: string | null;
        viewport: { width: number; height: number } | null;
        userAgent: string | null;
        appVersion: string | null;
    };
    createdAt: number;
    updatedAt: number;
    statusHistory: StatusHistoryEntry[];
    agentAnalysis: null;
    agentCategory: null;
    resolution: null;
}

function padId(n: number): string {
    return String(n).padStart(6, '0');
}

function makeTitle(description: string): string {
    const firstLine = description.trim().split(/\r?\n/)[0] ?? '';
    return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine;
}

function requireString(value: string | undefined, field: string, max: number): string | null {
    if (value === undefined) return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > max) throw new BadRequestException(`${field} must not exceed ${max} characters`);
    return trimmed;
}

function requireEnum<T extends string>(value: string | undefined, field: string, allowed: readonly T[], fallback?: T): T {
    if (value === undefined || value.trim() === '') {
        if (fallback !== undefined) return fallback;
        throw new BadRequestException(`${field} is required`);
    }
    const trimmed = value.trim();
    if (!allowed.includes(trimmed as T)) {
        throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}`);
    }
    return trimmed as T;
}

function optionalInt(value: number | undefined, field: string, min: number, max: number): number | null {
    if (value === undefined) return null;
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new BadRequestException(`${field} must be an integer between ${min} and ${max}`);
    }
    return Math.round(value);
}

@Injectable()
export class ReportsService {
    private readonly storage = new ReportsStorage();

    async create(input: ReportContextInput): Promise<CreatedReport> {
        if (!this.storage.isEnabled()) {
            throw new ServiceUnavailableException('Reports storage is not configured');
        }

        const type = requireEnum<ReportType>(input.type, 'type', REPORT_TYPES);
        const severity = requireEnum<ReportSeverity>(input.severity, 'severity', REPORT_SEVERITIES, 'medium');
        const description = requireString(input.description, 'description', MAX_DESCRIPTION);
        if (!description) throw new BadRequestException('description is required');
        const stepsToReproduce = requireString(input.stepsToReproduce, 'stepsToReproduce', MAX_STEPS);
        const url = requireString(input.url, 'url', MAX_URL);
        const locale = requireString(input.locale, 'locale', 16);
        const theme = requireString(input.theme, 'theme', 16);
        const userAgent = requireString(input.userAgent, 'userAgent', MAX_USER_AGENT);
        const appVersion = requireString(input.appVersion, 'appVersion', MAX_APP_VERSION);
        const viewportWidth = optionalInt(input.viewportWidth, 'viewportWidth', 0, 100_000);
        const viewportHeight = optionalInt(input.viewportHeight, 'viewportHeight', 0, 100_000);

        const number = await this.nextNumber();
        const id = padId(number);
        const now = Date.now();

        const screenshot = input.screenshot && input.screenshot.length > 0
            ? await this.processScreenshot(id, input.screenshot)
            : null;

        const report: StoredReport = {
            number,
            id,
            status: 'open',
            type,
            severity,
            title: makeTitle(description),
            description,
            stepsToReproduce,
            screenshot,
            reporter: {
                discordId: input.reporter.discordUserId,
                username: input.reporter.username,
                globalName: input.reporter.globalName,
            },
            context: {
                origin: config.reportsStorage.origin,
                url,
                campaignId: input.campaignId ?? null,
                guildId: input.guildId ?? null,
                locale,
                theme,
                viewport: viewportWidth !== null && viewportHeight !== null ? { width: viewportWidth, height: viewportHeight } : null,
                userAgent,
                appVersion,
            },
            createdAt: now,
            updatedAt: now,
            statusHistory: [{ status: 'open', at: now, by: 'user', note: 'report created' }],
            agentAnalysis: null,
            agentCategory: null,
            resolution: null,
        };

        await this.storage.putJson(
            `${REPORTS_PREFIX}${id}.json`,
            Buffer.from(JSON.stringify(report, null, 2), 'utf8'),
        );
        await this.refreshIndex();

        return { number, id, status: 'open', createdAt: now };
    }

    /**
     * Regenerate `reports/index.json` from the individual report JSONs. Called
     * after every new report (backend) and runnable on demand via the
     * `reports:sync-index` script so the index reflects status changes the
     * agent wrote back to the per-report JSONs.
     */
    async refreshIndex(): Promise<void> {
        if (!this.storage.isEnabled()) return;
        const keys = await this.storage.list(REPORTS_PREFIX);
        const reportKeys = keys.filter((k) => /^reports\/\d{6}\.json$/.test(k));
        const entries: Array<{
            number: number;
            id: string;
            status: ReportStatus;
            type: ReportType;
            severity: ReportSeverity;
            title: string;
            reporter: string | null;
            createdAt: number;
            hasScreenshot: boolean;
        }> = [];
        for (const key of reportKeys) {
            const buf = await this.storage.readBuffer(key);
            if (!buf) continue;
            try {
                const r = JSON.parse(buf.toString('utf8')) as StoredReport;
                entries.push({
                    number: r.number,
                    id: r.id,
                    status: r.status,
                    type: r.type,
                    severity: r.severity,
                    title: r.title,
                    reporter: r.reporter?.globalName ?? r.reporter?.username ?? null,
                    createdAt: r.createdAt,
                    hasScreenshot: Boolean(r.screenshot),
                });
            } catch {
                // Skip a corrupt report rather than fail the whole index.
            }
        }
        entries.sort((a, b) => a.number - b.number);
        const index = { generatedAt: Date.now(), reports: entries };
        await this.storage.putJson(INDEX_KEY, Buffer.from(JSON.stringify(index, null, 2), 'utf8'));
    }

    private async nextNumber(): Promise<number> {
        const keys = await this.storage.list(REPORTS_PREFIX);
        let max = 0;
        for (const key of keys) {
            const match = key.match(/^reports\/(\d{6})\.json$/);
            if (match) max = Math.max(max, parseInt(match[1], 10));
        }
        return max + 1;
    }

    private async processScreenshot(id: string, input: Buffer): Promise<StoredScreenshot> {
        const variants = await transformImageVariants(input);
        const base = `${REPORTS_PREFIX}${id}/screenshot`;
        const objectKey = `${base}.webp`;
        const thumbnailKey = `${base}-thumb.webp`;
        await this.storage.putImage(objectKey, variants.display);
        await this.storage.putImage(thumbnailKey, variants.thumbnail);
        return { objectKey, thumbnailKey, hasThumbnail: true };
    }
}