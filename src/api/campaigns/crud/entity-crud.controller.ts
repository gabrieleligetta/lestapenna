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
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiConflictResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiParam,
} from '@nestjs/swagger';
import { SessionGuard } from '../../auth/session.guard';
import { AuthenticatedRequest } from '../../auth/types';
import { CampaignAccessGuard } from '../campaignAccess.guard';
import { CampaignWriteGuard } from '../campaignWrite.guard';
import { assertMutationOrigin } from '../../common/mutationOrigin';
import { page, parsePagination, paginateArray } from '../../common/pagination';
import { EntityMediaService } from '../entityMedia.service';
import {
    EntityDeleteResultDto,
    EntityFragmentDto,
    EntityMutationResultDto,
    EventMutationDto,
    PaginatedEntityFragmentDto,
} from './entity-crud.dto';
import { EntityCrudService } from './entity-crud.service';
import {
    CRUD_ENTITY_TYPES,
    CrudEntityType,
    CrudRow,
    isCrudEntityType,
} from './entity-crud.registry';
import { projectEntity } from './entity-crud.projection';

function parseEntityType(value: unknown): CrudEntityType {
    if (!isCrudEntityType(value)) {
        throw new BadRequestException(`entityType must be one of: ${CRUD_ENTITY_TYPES.join(', ')}`);
    }
    return value;
}

function parseEventId(value: string): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('eventId must be a positive integer');
    return id;
}

/** First line of the fragment: it is the canonical header when there is one. */
function fragmentHeader(content: string): string {
    return content.split('\n', 1)[0].trim().slice(0, 200);
}

/**
 * Management of campaign data: create, update, delete of every entity family,
 * plus correcting the history and pruning the RAG memory.
 *
 * It lives in a separate controller because `campaigns.controller.ts` is already
 * long; the mutations go through the registry in `entity-crud.registry.ts`, which
 * is the only place where the storage differences between the eight families live.
 *
 * `CampaignWriteGuard` sits on the individual routes and not on the class: `GET
 * fragments` is a read, and consulting the Bardo's memory about an NPC is
 * looking at the campaign, not modifying it — so it stays accessible to the
 * whole guild like the rest of consultation.
 *
 * `:entityType` is a parameter, as already in `merge/:entityType`: the list comes
 * from the registry and a value outside it is an explicit 400, not a mute route.
 */
@Controller('api/v1/campaigns')
@UseGuards(SessionGuard, CampaignAccessGuard)
@ApiParam({ name: 'entityType', enum: CRUD_ENTITY_TYPES })
export class EntityCrudController {
    constructor(
        private readonly crud: EntityCrudService,
        private readonly entityMedia: EntityMediaService,
    ) {}

    @Post(':campaignId/:entityType')
    @UseGuards(CampaignWriteGuard)
    @ApiForbiddenResponse({ description: 'You must be part of this campaign to change it.' })
    @ApiOkResponse({ type: EntityMutationResultDto })
    @ApiBadRequestResponse({ description: 'Invalid entity type or field values.' })
    @ApiConflictResponse({ description: 'An entity with the same natural key already exists.' })
    create(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') rawType: string,
        @Body() body: unknown,
    ): EntityMutationResultDto {
        assertMutationOrigin(request);
        const entityType = parseEntityType(rawType);
        const created = this.crud.create(entityType, request.campaignId!, body);
        return this.toMutationResult(entityType, created);
    }

    @Patch(':campaignId/:entityType/:shortId')
    @UseGuards(CampaignWriteGuard)
    @ApiForbiddenResponse({ description: 'You must be part of this campaign to change it.' })
    @ApiOkResponse({ type: EntityMutationResultDto })
    @ApiNotFoundResponse({ description: 'No entity with that short id in this campaign.' })
    @ApiConflictResponse({ description: 'The new name is already taken by another entity.' })
    update(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') rawType: string,
        @Param('shortId') shortId: string,
        @Body() body: unknown,
    ): EntityMutationResultDto {
        assertMutationOrigin(request);
        const entityType = parseEntityType(rawType);
        const updated = this.crud.update(entityType, request.campaignId!, shortId, body);
        return this.toMutationResult(entityType, updated);
    }

    /**
     * Deletes the entity and everything that names it: history, RAG cards,
     * typed references, affiliations and image. The report says what was
     * removed, so the UI can tell the user instead of just making the entity
     * disappear.
     */
    @Delete(':campaignId/:entityType/:shortId')
    @UseGuards(CampaignWriteGuard)
    @ApiForbiddenResponse({ description: 'You must be part of this campaign to change it.' })
    @ApiOkResponse({ type: EntityDeleteResultDto })
    @ApiNotFoundResponse({ description: 'No entity with that short id in this campaign.' })
    @ApiBadRequestResponse({ description: 'This entity cannot be deleted (e.g. the Party faction).' })
    async remove(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') rawType: string,
        @Param('shortId') shortId: string,
    ): Promise<EntityDeleteResultDto> {
        assertMutationOrigin(request);
        const entityType = parseEntityType(rawType);
        const { entity, report, mediaObjectKeys } = this.crud.remove(
            entityType, request.campaignId!, shortId,
        );

        // Objects on storage live outside the transaction: the entity is already
        // gone, and a failure here leaves an orphan file — better than a
        // 500 on a deletion that succeeded.
        await this.entityMedia.deleteOrphanedObjects(mediaObjectKeys).catch(() => undefined);

        return { name: this.crud.spec(entityType).label(entity), report };
    }

    // --- History: correcting and deleting a single event ---------------------

    /**
     * Corrects a history event.
     *
     * On NPCs, characters and factions it also accepts `moral_weight`/`ethical_weight`:
     * they are the values the entity's aggregated alignment is computed from, and
     * it is re-aggregated in the same transaction.
     */
    @Patch(':campaignId/:entityType/:shortId/events/:eventId')
    @UseGuards(CampaignWriteGuard)
    @ApiForbiddenResponse({ description: 'You must be part of this campaign to change it.' })
    @ApiOkResponse({ description: 'Event updated.' })
    @ApiNotFoundResponse({ description: 'No such event on this entity.' })
    @HttpCode(204)
    updateEvent(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') rawType: string,
        @Param('shortId') shortId: string,
        @Param('eventId') rawEventId: string,
        @Body() body: EventMutationDto,
    ): void {
        assertMutationOrigin(request);
        const entityType = parseEntityType(rawType);
        const campaignId = request.campaignId!;
        const entity = this.crud.require(entityType, campaignId, shortId);
        const { table, row } = this.crud.requireEvent(
            entityType, campaignId, entity, parseEventId(rawEventId),
        );
        this.crud.updateEvent(table, row, this.crud.parseEventMutation(table, body));
    }

    @Delete(':campaignId/:entityType/:shortId/events/:eventId')
    @UseGuards(CampaignWriteGuard)
    @ApiForbiddenResponse({ description: 'You must be part of this campaign to change it.' })
    @HttpCode(204)
    @ApiNotFoundResponse({ description: 'No such event on this entity.' })
    deleteEvent(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') rawType: string,
        @Param('shortId') shortId: string,
        @Param('eventId') rawEventId: string,
    ): void {
        assertMutationOrigin(request);
        const entityType = parseEntityType(rawType);
        const campaignId = request.campaignId!;
        const entity = this.crud.require(entityType, campaignId, shortId);
        const { table, row } = this.crud.requireEvent(
            entityType, campaignId, entity, parseEventId(rawEventId),
        );
        this.crud.deleteEvent(table, Number(row.id));
    }

    // --- Memoria a lungo termine (RAG) --------------------------------------

    /**
     * The memory fragments that talk about this entity.
     *
     * It is the only place where you can see what the Bardo really "remembers"
     * about an NPC or a location: until now the memory was writable by the
     * pipeline and readable only by semantic search.
     */
    @Get(':campaignId/:entityType/:shortId/fragments')
    @ApiOkResponse({ type: PaginatedEntityFragmentDto })
    listFragments(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') rawType: string,
        @Param('shortId') shortId: string,
        @Query() query: { limit?: string; offset?: string },
    ) {
        const entityType = parseEntityType(rawType);
        const campaignId = request.campaignId!;
        const entity = this.crud.require(entityType, campaignId, shortId);
        const snapshotSessionId = this.crud.spec(entityType).fragmentQuery(entity).snapshotSessionId;

        const rows = this.crud.listFragments(entityType, campaignId, entity);
        const pagination = parsePagination(query);
        const items = paginateArray(rows, pagination).map((row): EntityFragmentDto => ({
            id: row.id,
            session_id: row.session_id,
            header: fragmentHeader(row.content),
            content: row.content,
            created_at: row.created_at ?? row.start_timestamp ?? null,
            macro_location: row.macro_location,
            micro_location: row.micro_location,
            is_entity_snapshot: Boolean(snapshotSessionId) && row.session_id === snapshotSessionId,
        }));
        return page(items, rows.length, pagination);
    }

    /**
     * Deletes a fragment that is no longer relevant.
     *
     * Deleting a memory is final and cannot be regenerated: the source text is a
     * session transcript, which is not reprocessed on demand. The UI says so
     * before asking for confirmation.
     */
    @Delete(':campaignId/:entityType/:shortId/fragments/:fragmentId')
    @UseGuards(CampaignWriteGuard)
    @ApiForbiddenResponse({ description: 'You must be part of this campaign to change it.' })
    @HttpCode(204)
    @ApiNotFoundResponse({ description: 'That fragment is not linked to this entity.' })
    deleteFragment(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') rawType: string,
        @Param('shortId') shortId: string,
        @Param('fragmentId') rawFragmentId: string,
    ): void {
        assertMutationOrigin(request);
        const entityType = parseEntityType(rawType);
        const campaignId = request.campaignId!;
        const entity = this.crud.require(entityType, campaignId, shortId);
        this.crud.deleteFragment(entityType, campaignId, entity, parseEventId(rawFragmentId));
    }

    private toMutationResult(entityType: CrudEntityType, row: CrudRow): EntityMutationResultDto {
        return {
            ...projectEntity(entityType, row),
            short_id: (row.short_id as string | null) ?? null,
        };
    }
}
