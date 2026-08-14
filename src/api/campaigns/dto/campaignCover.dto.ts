import { ApiProperty } from '@nestjs/swagger';

export class CampaignCoverDto {
    @ApiProperty({ description: 'Where the card fetches the cover thumbnail.' })
    coverUrl!: string;

    @ApiProperty({ description: 'Epoch milliseconds.' })
    updatedAt!: number;
}
