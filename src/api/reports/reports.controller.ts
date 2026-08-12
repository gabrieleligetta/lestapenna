import { BadRequestException, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiOperation } from '@nestjs/swagger';
import { SessionGuard } from '../auth/session.guard';
import type { AuthenticatedRequest } from '../auth/types';
import { config } from '../../config';
import { CreatedReportDto, REPORT_SEVERITIES, REPORT_TYPES } from './dto/report.dto';
import { sendReportEmail } from './reportEmail';
import { ReportsService } from './reports.service';

type MultipartRequest = AuthenticatedRequest & {
    parts: (options?: Record<string, unknown>) => AsyncIterable<
        | { type: 'file'; fieldname: string; toBuffer: () => Promise<Buffer>; mimetype: string; filename: string }
        | { type: 'field'; fieldname: string; value: unknown }
    >;
};

const ALLOWED_FIELDS = new Set([
    'type',
    'description',
    'severity',
    'steps',
    'url',
    'locale',
    'theme',
    'viewportWidth',
    'viewportHeight',
    'userAgent',
    'campaignId',
    'guildId',
    'appVersion',
]);

function assertMutationOrigin(request: AuthenticatedRequest): void {
    if (request.headers['sec-fetch-site'] === 'cross-site') {
        throw new BadRequestException('Cross-site report mutations are not accepted');
    }
    const origin = request.headers.origin;
    if (!origin) return;
    try {
        if (new URL(origin).origin !== new URL(config.discordOAuth.publicBaseUrl).origin) {
            throw new BadRequestException('Invalid request origin');
        }
    } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException('Invalid request origin');
    }
}

function asString(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new BadRequestException(`${field} must be text`);
    return value;
}

function asNumber(value: unknown, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new BadRequestException(`${field} must be numeric`);
    return parsed;
}

@Controller('api/v1/reports')
@UseGuards(SessionGuard)
export class ReportsController {
    constructor(private readonly reports: ReportsService) {}

    @Post()
    @ApiOperation({ summary: 'Submit a bug / issue / improvement report.' })
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            required: ['type', 'description'],
            properties: {
                type: { type: 'string', enum: [...REPORT_TYPES] },
                description: { type: 'string', maxLength: 4000 },
                severity: { type: 'string', enum: [...REPORT_SEVERITIES] },
                steps: { type: 'string', maxLength: 2000 },
                url: { type: 'string', maxLength: 500 },
                locale: { type: 'string', maxLength: 16 },
                theme: { type: 'string', maxLength: 16 },
                viewportWidth: { type: 'number' },
                viewportHeight: { type: 'number' },
                userAgent: { type: 'string', maxLength: 500 },
                campaignId: { type: 'number' },
                guildId: { type: 'string' },
                appVersion: { type: 'string', maxLength: 64 },
                screenshot: { type: 'string', format: 'binary' },
            },
        },
    })
    @ApiCreatedResponse({ type: CreatedReportDto, description: 'Report persisted to the bucket with a progressive number.' })
    async create(@Req() request: MultipartRequest): Promise<CreatedReportDto> {
        assertMutationOrigin(request);

        const fields: Record<string, string | number | undefined> = {};
        let screenshot: Buffer | undefined;
        let screenshotMeta: { mimetype: string; filename: string } | undefined;

        try {
            for await (const part of request.parts()) {
                if (part.type === 'file') {
                    if (part.fieldname !== 'screenshot') {
                        throw new BadRequestException(`Unexpected file field: ${part.fieldname}`);
                    }
                    if (screenshot) throw new BadRequestException('Only one screenshot may be uploaded');
                    screenshot = await part.toBuffer();
                    screenshotMeta = { mimetype: part.mimetype, filename: part.filename };
                    continue;
                }
                if (!ALLOWED_FIELDS.has(part.fieldname)) {
                    throw new BadRequestException(`Unexpected multipart field: ${part.fieldname}`);
                }
                if (part.fieldname === 'viewportWidth' || part.fieldname === 'viewportHeight') {
                    fields[part.fieldname] = asNumber(part.value, part.fieldname);
                } else if (part.fieldname === 'campaignId') {
                    fields.campaignId = asNumber(part.value, 'campaignId');
                } else {
                    fields[part.fieldname] = asString(part.value, part.fieldname);
                }
            }
        } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
                throw new BadRequestException('Screenshot exceeds the 5 MiB limit');
            }
            throw error;
        }

        const { discordUserId, username, globalName } = request.webSession;
        const created = await this.reports.create({
            type: asString(fields.type, 'type'),
            description: asString(fields.description, 'description'),
            severity: asString(fields.severity, 'severity'),
            stepsToReproduce: asString(fields.steps, 'stepsToReproduce'),
            url: asString(fields.url, 'url'),
            locale: asString(fields.locale, 'locale'),
            theme: asString(fields.theme, 'theme'),
            viewportWidth: fields.viewportWidth as number | undefined,
            viewportHeight: fields.viewportHeight as number | undefined,
            userAgent: asString(fields.userAgent, 'userAgent'),
            campaignId: fields.campaignId as number | undefined,
            guildId: asString(fields.guildId, 'guildId'),
            appVersion: asString(fields.appVersion, 'appVersion'),
            screenshot,
            reporter: { discordUserId, username, globalName },
        });

        // Fire-and-forget: the report is already persisted to the bucket; the
        // email to TECHNICAL_REPORT_RECIPIENT must not delay the response.
        void sendReportEmail({
            number: created.number,
            id: created.id,
            createdAt: created.createdAt,
            type: asString(fields.type, 'type') ?? 'OTHER',
            severity: asString(fields.severity, 'severity') ?? 'medium',
            description: asString(fields.description, 'description') ?? '',
            steps: asString(fields.steps, 'stepsToReproduce') ?? null,
            url: asString(fields.url, 'url') ?? null,
            locale: asString(fields.locale, 'locale') ?? null,
            theme: asString(fields.theme, 'theme') ?? null,
            viewport:
                (fields.viewportWidth as number | undefined) != null && (fields.viewportHeight as number | undefined) != null
                    ? { width: fields.viewportWidth as number, height: fields.viewportHeight as number }
                    : null,
            userAgent: asString(fields.userAgent, 'userAgent') ?? null,
            campaignId: fields.campaignId as number | undefined ?? null,
            guildId: asString(fields.guildId, 'guildId') ?? null,
            appVersion: asString(fields.appVersion, 'appVersion') ?? null,
            reporter: { discordId: discordUserId, username, globalName },
            origin: config.reportsStorage.origin,
            screenshot: screenshot && screenshotMeta
                ? { buffer: screenshot, mimetype: screenshotMeta.mimetype, filename: screenshotMeta.filename }
                : null,
        });

        return created;
    }
}