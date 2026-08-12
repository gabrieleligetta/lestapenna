import { ApiProperty } from '@nestjs/swagger';
import { REFERENCE_SCOPES, type ReferenceScope } from '../../../db/types';

/**
 * A picture the image model is told to draw from.
 *
 * The bytes are not in here: they live behind the read route, like every other
 * private object in this app, so a reference is served through the same signed
 * short-lived path as a portrait rather than embedded in a JSON payload.
 */
export class ReferenceImageDto {
    @ApiProperty() id!: string;
    @ApiProperty({ enum: REFERENCE_SCOPES }) scope!: ReferenceScope;
    @ApiProperty({ description: 'Empty for a campaign reference; the faction short id, or "<type>:<short id>".' })
    scope_key!: string;
    @ApiProperty({ description: 'Where to fetch the bytes, same signed short-lived path as a portrait.' })
    imageUrl!: string;
    @ApiProperty() width!: number;
    @ApiProperty() height!: number;
    @ApiProperty({ nullable: true }) label!: string | null;
    @ApiProperty() created_at!: number;
}
