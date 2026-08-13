import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    Put,
    Query,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBody,
    ApiConflictResponse,
    ApiAcceptedResponse,
    ApiConsumes,
    ApiFoundResponse,
    ApiNoContentResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiParam,
    ApiQuery,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { SessionGuard } from '../auth/session.guard';
import type { AuthenticatedRequest } from '../auth/types';
import { CampaignAccessGuard } from './campaignAccess.guard';
import { EntityImageDto, UpdateEntityImageDto } from './dto/media.dto';
import { EntityMediaService, type ImageUploadPresentation } from './entityMedia.service';
import { ImageGenerationService } from './imageGeneration.service';
import {
    GenerateEntityImageDto,
    ImageGenerationEstimateDto,
    ReferenceCandidateDto,
} from './dto/imageGeneration.dto';
import { AiJobAcceptedDto, AiJobDto } from './dto/aiJob.dto';
import {
    EntityProfileDto,
    EntityProfileEstimateDto,
    UpdateEntityProfileDto,
} from './dto/entityProfile.dto';
import { ReferenceImageDto, UpdateReferenceImageDto } from './dto/referenceImage.dto';
import { EntityProfileService } from './entityProfile.service';
import { ReferenceImagesService } from './referenceImages.service';
import { IMAGE_GENERATION_MODES, REFERENCE_SCOPES, type ImageGenerationMode } from '../../db/types';
import { config } from '../../config';

type MultipartRequest = AuthenticatedRequest & {
    parts: (options?: Record<string, unknown>) => AsyncIterable<
        | { type: 'file'; fieldname: string; toBuffer: () => Promise<Buffer> }
        | { type: 'field'; fieldname: string; value: unknown }
    >;
};

function assertMutationOrigin(request: AuthenticatedRequest): void {
    if (request.headers['sec-fetch-site'] === 'cross-site') {
        throw new BadRequestException('Cross-site media mutations are not accepted');
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

function parseOptionalNumber(value: unknown, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim() === '') {
        throw new BadRequestException(`${field} must be numeric`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new BadRequestException(`${field} must be numeric`);
    return parsed;
}

@Controller('api/v1/campaigns')
@UseGuards(SessionGuard, CampaignAccessGuard)
export class EntityMediaController {
    constructor(
        private readonly media: EntityMediaService,
        private readonly generation: ImageGenerationService,
        private readonly profiles: EntityProfileService,
        private readonly references: ReferenceImagesService,
    ) {}

    @Put(':campaignId/:entityType/:entityId/image')
    @ApiConsumes('multipart/form-data')
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiBody({
        schema: {
            type: 'object',
            required: ['file'],
            properties: {
                file: { type: 'string', format: 'binary' },
                focalX: { type: 'number', minimum: 0, maximum: 100 },
                focalY: { type: 'number', minimum: 0, maximum: 100 },
                altText: { type: 'string', maxLength: 300 },
            },
        },
    })
    @ApiOkResponse({ type: EntityImageDto })
    async upload(
        @Req() request: MultipartRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
    ): Promise<EntityImageDto> {
        assertMutationOrigin(request);
        let file: Buffer | undefined;
        const presentation: ImageUploadPresentation = {};

        try {
            for await (const part of request.parts()) {
                if (part.type === 'file') {
                    if (part.fieldname !== 'file') throw new BadRequestException('The image field must be named file');
                    if (file) throw new BadRequestException('Only one image file may be uploaded');
                    file = await part.toBuffer();
                    continue;
                }
                if (part.fieldname === 'focalX') presentation.focalX = parseOptionalNumber(part.value, 'focalX');
                else if (part.fieldname === 'focalY') presentation.focalY = parseOptionalNumber(part.value, 'focalY');
                else if (part.fieldname === 'altText') {
                    if (typeof part.value !== 'string') throw new BadRequestException('altText must be text');
                    presentation.altText = part.value;
                } else {
                    throw new BadRequestException(`Unexpected multipart field: ${part.fieldname}`);
                }
            }
        } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
                throw new BadRequestException('Image exceeds the 5 MiB limit');
            }
            throw error;
        }

        if (!file) throw new BadRequestException('Multipart field file is required');
        return this.media.upload(request, entityType, entityId, file, presentation);
    }

    /** Every picture of one entity, the main one first. */
    @Get(':campaignId/:entityType/:entityId/images')
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiOkResponse({ type: [EntityImageDto] })
    listImages(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
    ): EntityImageDto[] {
        return this.media.listImages(request, entityType, entityId);
    }

    /** Chooses which of an entity's pictures the sheet shows. */
    @Post(':campaignId/media/:mediaId/primary')
    @ApiOkResponse({ type: EntityImageDto })
    setPrimary(
        @Req() request: AuthenticatedRequest,
        @Param('mediaId') mediaId: string,
    ): EntityImageDto {
        assertMutationOrigin(request);
        return this.media.setPrimary(request, mediaId);
    }

    /** Removes one picture from the gallery, rather than all of them. */
    @Delete(':campaignId/media/:mediaId')
    @HttpCode(204)
    @ApiNoContentResponse()
    async deleteOne(
        @Req() request: AuthenticatedRequest,
        @Param('mediaId') mediaId: string,
    ): Promise<void> {
        assertMutationOrigin(request);
        await this.media.deleteOne(request, mediaId);
    }

    @Patch(':campaignId/media/:mediaId')
    @ApiOkResponse({ type: EntityImageDto })
    update(
        @Req() request: AuthenticatedRequest,
        @Param('mediaId') mediaId: string,
        @Body() body: UpdateEntityImageDto,
    ): EntityImageDto {
        assertMutationOrigin(request);
        return this.media.update(request, mediaId, body ?? {});
    }

    @Delete(':campaignId/:entityType/:entityId/image')
    @HttpCode(204)
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiNoContentResponse()
    async delete(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
    ): Promise<void> {
        assertMutationOrigin(request);
        await this.media.delete(request, entityType, entityId);
    }

    /**
     * What a portrait would cost, before anything is spent.
     *
     * A `GET` on purpose, and it builds no client and reads no credential: a
     * table that has not configured a key yet must still be able to find out
     * what the action would cost them.
     */
    @Get(':campaignId/:entityType/:entityId/image/generate/estimate')
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiQuery({ name: 'mode', enum: IMAGE_GENERATION_MODES })
    @ApiOkResponse({ type: ImageGenerationEstimateDto })
    estimateGeneration(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
        @Query('mode') mode: string,
    ): Promise<ImageGenerationEstimateDto> {
        const chosen = IMAGE_GENERATION_MODES.includes(mode as ImageGenerationMode)
            ? mode as ImageGenerationMode
            : 'auto';
        return this.generation.estimate(request, entityType, entityId, chosen);
    }

    /** Full-draft estimate, including selected reference input costs and limits. */
    @Post(':campaignId/:entityType/:entityId/image/generate/estimate')
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiOkResponse({ type: ImageGenerationEstimateDto })
    estimateGenerationDraft(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
        @Body() body: GenerateEntityImageDto,
    ): Promise<ImageGenerationEstimateDto> {
        return this.generation.estimate(
            request,
            entityType,
            entityId,
            body ?? ({} as GenerateEntityImageDto),
        );
    }

    /**
     * Accepts the request to draw a picture, and hands back the job.
     *
     * **202, not 200.** The drawing happens outside this request: the money is
     * spent when the provider is called, whatever the person decides about the
     * result — which is why the cost confirmation belongs in front of this route
     * — and holding a connection open for a minute is how a network blip used to
     * throw away something already paid for.
     */
    @Post(':campaignId/:entityType/:entityId/image/generate')
    @HttpCode(202)
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiAcceptedResponse({ type: AiJobAcceptedDto })
    @ApiConflictResponse({ description: 'A picture for this entity is already being generated.' })
    generate(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
        @Body() body: GenerateEntityImageDto,
    ): AiJobAcceptedDto {
        assertMutationOrigin(request);
        return this.generation.enqueue(request, entityType, entityId, body ?? ({} as GenerateEntityImageDto));
    }

    /**
     * The generation this entity already has going, if any.
     *
     * What lets the panel pick up where it left off after the modal was closed,
     * the page navigated away from, or the server restarted — the case the whole
     * register exists for.
     */
    @Get(':campaignId/:entityType/:entityId/image/generate/pending')
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiOkResponse({ type: AiJobDto, description: 'Null when there is nothing in flight.' })
    pendingGeneration(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
    ): AiJobDto | null {
        return this.generation.pending(request, entityType, entityId);
    }

    /**
     * The pictures this generation could draw from.
     *
     * Contextual defaults can be preselected, but every choice is listed for
     * the person to inspect or clear before confirming the paid request.
     */
    @Get(':campaignId/:entityType/:entityId/image/generate/references')
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiOkResponse({ type: [ReferenceCandidateDto] })
    referenceCandidates(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
    ): ReferenceCandidateDto[] {
        return this.generation.referenceCandidates(request, entityType, entityId);
    }

    /**
     * A picture for this generation only.
     *
     * It is not catalogued in the gallery or permanent references. Its private
     * bytes are kept only long enough for the durable asynchronous job to use
     * them, then removed automatically.
     */
    @Post(':campaignId/references/one-time')
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            required: ['file'],
            properties: {
                file: { type: 'string', format: 'binary' },
                label: { type: 'string', maxLength: 120 },
            },
        },
    })
    @ApiOkResponse({ type: ReferenceCandidateDto })
    async addOneTimeReference(@Req() request: MultipartRequest): Promise<ReferenceCandidateDto> {
        assertMutationOrigin(request);
        let file: Buffer | undefined;
        let label: string | null = null;

        try {
            for await (const part of request.parts()) {
                if (part.type === 'file') {
                    if (part.fieldname !== 'file') throw new BadRequestException('The image field must be named file');
                    if (file) throw new BadRequestException('Only one image file may be uploaded');
                    file = await part.toBuffer();
                    continue;
                }
                if (part.fieldname === 'label') {
                    if (typeof part.value !== 'string') throw new BadRequestException('label must be text');
                    label = part.value;
                } else {
                    throw new BadRequestException(`Unexpected multipart field: ${part.fieldname}`);
                }
            }
        } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
                throw new BadRequestException('Image exceeds the 5 MiB limit');
            }
            throw error;
        }

        if (!file) throw new BadRequestException('Multipart field file is required');
        return this.references.holdScratch(request, file, label);
    }

    /**
     * The picture a job is holding, while it waits for a decision.
     *
     * A route rather than base64 in the job: the bytes are in the bucket from
     * the moment they were paid for, so there is something to address — and the
     * job payload stays small enough to poll.
     */
    @Get(':campaignId/:entityType/:entityId/image/generate/:jobId/preview')
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiNotFoundResponse({ description: 'The job holds no picture.' })
    async generationPreview(
        @Req() request: AuthenticatedRequest,
        @Param('jobId') jobId: string,
        @Res() reply: FastifyReply,
    ) {
        const found = await this.generation.readPreview(request, jobId);
        reply.header('Cache-Control', 'private, max-age=300');
        reply.header('X-Content-Type-Options', 'nosniff');
        if (found.kind === 'redirect') return reply.redirect(found.url, 302);
        return reply.type('image/webp').send(found.body);
    }

    /** Keeps a generated picture, through the same path an upload takes. */
    @Post(':campaignId/:entityType/:entityId/image/generate/:jobId/commit')
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiOkResponse({ type: EntityImageDto })
    @ApiNotFoundResponse({ description: 'The picture is no longer waiting for a decision.' })
    commitGeneration(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
        @Param('jobId') jobId: string,
    ): Promise<EntityImageDto> {
        assertMutationOrigin(request);
        return this.generation.commit(request, entityType, entityId, jobId);
    }

    /** Refuses a picture. The money is gone either way; the bytes need not stay. */
    @Delete(':campaignId/:entityType/:entityId/image/generate/:jobId')
    @HttpCode(204)
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiNoContentResponse()
    discardGeneration(
        @Req() request: AuthenticatedRequest,
        @Param('jobId') jobId: string,
    ): Promise<void> {
        assertMutationOrigin(request);
        return this.generation.discard(request, jobId);
    }

    /**
     * What this campaign records about how an entity looks.
     *
     * Readable by anyone who can see the sheet: it is campaign content, like the
     * description it sits next to. 204 when the subject has never been analysed
     * — an absent dossier is a normal state, not an error.
     */
    @Get(':campaignId/:entityType/:entityId/profile')
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiOkResponse({ type: EntityProfileDto })
    @ApiNoContentResponse({ description: 'This entity has no appearance dossier yet.' })
    getProfile(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
        @Res({ passthrough: true }) reply: FastifyReply,
    ): EntityProfileDto | undefined {
        const profile = this.profiles.get(request, entityType, entityId);
        if (!profile) {
            reply.status(204);
            return undefined;
        }
        return profile;
    }

    /** What the analysis would cost. Holds no credential, so a table without a key can still ask. */
    @Get(':campaignId/:entityType/:entityId/profile/analyze/estimate')
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiOkResponse({ type: EntityProfileEstimateDto })
    estimateAnalysis(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
    ): Promise<EntityProfileEstimateDto> {
        return this.profiles.estimate(request, entityType, entityId);
    }

    /**
     * Reads the campaign for this subject and stores what it can evidence.
     *
     * 202 like the generation, and for the same reason: this is an agent with a
     * tool budget, not a round trip, and the answer must not depend on a browser
     * staying connected for it.
     */
    @Post(':campaignId/:entityType/:entityId/profile/analyze')
    @HttpCode(202)
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiAcceptedResponse({ type: AiJobAcceptedDto })
    @ApiConflictResponse({ description: 'This entity is already being analysed.' })
    analyzeProfile(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
    ): AiJobAcceptedDto {
        assertMutationOrigin(request);
        return this.profiles.enqueue(request, entityType, entityId);
    }

    /** A correction by hand, which a later analysis will not overwrite. */
    @Patch(':campaignId/:entityType/:entityId/profile')
    @ApiParam({ name: 'entityType', enum: ['npc', 'location', 'character', 'artifact'] })
    @ApiOkResponse({ type: EntityProfileDto })
    updateProfile(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Param('entityId') entityId: string,
        @Body() body: UpdateEntityProfileDto,
    ): EntityProfileDto {
        assertMutationOrigin(request);
        return this.profiles.update(request, entityType, entityId, body ?? {});
    }

    @Get(':campaignId/references')
    @ApiQuery({ name: 'scope', enum: REFERENCE_SCOPES })
    @ApiQuery({ name: 'key', required: false, description: 'Faction short id, or "<type>:<short id>".' })
    @ApiOkResponse({ type: [ReferenceImageDto] })
    listReferences(
        @Req() request: AuthenticatedRequest,
        @Query('scope') scope: string,
        @Query('key') key?: string,
    ): ReferenceImageDto[] {
        return this.references.list(request, this.references.parseScope(scope), key ?? '');
    }

    /**
     * Uploads a picture for the model to draw from.
     *
     * Same multipart handling as a portrait upload, and the same 5 MiB ceiling
     * enforced by the server rather than trusted from the browser.
     */
    @Post(':campaignId/references')
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            required: ['file', 'scope'],
            properties: {
                file: { type: 'string', format: 'binary' },
                scope: { type: 'string', enum: ['campaign', 'faction'] },
                key: { type: 'string' },
                label: { type: 'string', maxLength: 120 },
                roles: { type: 'string', description: 'JSON array of reference roles.' },
                instruction: { type: 'string', maxLength: 300 },
                autoSelect: { type: 'boolean' },
            },
        },
    })
    @ApiOkResponse({ type: ReferenceImageDto })
    async addReference(@Req() request: MultipartRequest): Promise<ReferenceImageDto> {
        assertMutationOrigin(request);
        let file: Buffer | undefined;
        let scope = '';
        let key = '';
        let label: string | null = null;
        let roles: unknown = undefined;
        let instruction: string | null = null;
        let autoSelect: unknown = undefined;

        try {
            for await (const part of request.parts()) {
                if (part.type === 'file') {
                    if (part.fieldname !== 'file') throw new BadRequestException('The image field must be named file');
                    if (file) throw new BadRequestException('Only one image file may be uploaded');
                    file = await part.toBuffer();
                    continue;
                }
                if (typeof part.value !== 'string') throw new BadRequestException(`${part.fieldname} must be text`);
                if (part.fieldname === 'scope') scope = part.value;
                else if (part.fieldname === 'key') key = part.value;
                else if (part.fieldname === 'label') label = part.value;
                else if (part.fieldname === 'roles') {
                    try {
                        roles = JSON.parse(part.value);
                    } catch {
                        throw new BadRequestException('roles must be a JSON array');
                    }
                } else if (part.fieldname === 'instruction') instruction = part.value;
                else if (part.fieldname === 'autoSelect') autoSelect = part.value;
                else throw new BadRequestException(`Unexpected multipart field: ${part.fieldname}`);
            }
        } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
                throw new BadRequestException('Image exceeds the 5 MiB limit');
            }
            throw error;
        }

        if (!file) throw new BadRequestException('Multipart field file is required');
        return this.references.add(
            request,
            this.references.parseScope(scope),
            key,
            file,
            label,
            { roles, instruction, autoSelect },
        );
    }

    @Patch(':campaignId/references/:referenceId')
    @ApiOkResponse({ type: ReferenceImageDto })
    updateReference(
        @Req() request: AuthenticatedRequest,
        @Param('referenceId') referenceId: string,
        @Body() body: UpdateReferenceImageDto,
    ): ReferenceImageDto {
        assertMutationOrigin(request);
        return this.references.update(request, referenceId, body ?? ({} as UpdateReferenceImageDto));
    }

    @Delete(':campaignId/references/:referenceId')
    @HttpCode(204)
    @ApiNoContentResponse()
    async deleteReference(
        @Req() request: AuthenticatedRequest,
        @Param('referenceId') referenceId: string,
    ): Promise<void> {
        assertMutationOrigin(request);
        await this.references.remove(request, referenceId);
    }

    @Get(':campaignId/references/:referenceId/image')
    @ApiOkResponse({ content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } } })
    async readReference(
        @Req() request: AuthenticatedRequest,
        @Param('referenceId') referenceId: string,
        @Res() reply: FastifyReply,
    ) {
        const result = await this.references.read(request.campaignId!, referenceId);
        if (!result) return reply.status(404).send({ message: 'Reference image not found' });
        reply.header('Cache-Control', 'private, max-age=300');
        reply.header('X-Content-Type-Options', 'nosniff');
        return reply.type(result.mimeType).send(result.bytes);
    }

    @Get(':campaignId/media/:mediaId/:variant')
    @ApiParam({ name: 'variant', enum: ['thumbnail', 'display'] })
    @ApiOkResponse({
        content: {
            'image/webp': { schema: { type: 'string', format: 'binary' } },
        },
    })
    @ApiFoundResponse({ description: 'Redirect to a short-lived signed private-object URL.' })
    async read(
        @Req() request: AuthenticatedRequest,
        @Param('mediaId') mediaId: string,
        @Param('variant') variant: string,
        @Res() reply: FastifyReply,
    ) {
        const result = await this.media.read(request.campaignId!, mediaId, variant);
        if (!result) return reply.status(404).send({ message: 'Image object not found' });
        reply.header('Cache-Control', 'private, max-age=300');
        reply.header('X-Content-Type-Options', 'nosniff');
        if (result.kind === 'redirect') return reply.redirect(result.url, 302);
        return reply.type('image/webp').send(result.body);
    }
}
