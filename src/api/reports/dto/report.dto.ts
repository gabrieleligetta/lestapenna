import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const REPORT_TYPES = [
    'BUG',
    'UI',
    'UX',
    'DATA',
    'FLOW',
    'PERFORMANCE',
    'SECURITY',
    'CONTENT',
    'FEATURE',
    'OTHER',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ReportSeverity = (typeof REPORT_SEVERITIES)[number];

export const REPORT_STATUSES = ['open', 'in_progress', 'resolved', 'closed', 'wontfix'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Response returned to the SPA after a report is persisted. */
export class CreatedReportDto {
    @ApiProperty({ example: 1, description: 'Progressive report number (also encoded in the stored id).' })
    number!: number;

    @ApiProperty({ example: '000001', description: 'Zero-padded 6-digit report id / object key suffix.' })
    id!: string;

    @ApiProperty({ enum: REPORT_STATUSES, enumName: 'ReportStatus' })
    status!: ReportStatus;

    @ApiProperty({ example: 1721900000000, description: 'Creation timestamp (epoch ms).' })
    createdAt!: number;
}