import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    NotFoundException,
    HttpException,
    HttpStatus,
    Param,
    Patch,
    Post,
    Query,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import {
    ApiAcceptedResponse,
    ApiBadRequestResponse,
    ApiConflictResponse,
    ApiForbiddenResponse,
    ApiFoundResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiParam,
    ApiQuery,
} from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { SessionGuard } from '../auth/session.guard';
import { CampaignAccessGuard } from './campaignAccess.guard';
import { CampaignWriteGuard } from './campaignWrite.guard';
import { AuthenticatedRequest } from '../auth/types';
import { parsePagination, page, pageFromArray } from '../common/pagination';
import { parseSearch, parseSort, sortRows, filterRows } from '../common/sorting';
import { PaginatedHistoryEventDto, toEventPage } from './dto/events.dto';
import {
    FactionDetailDto,
    PaginatedFactionMemberDto,
    toFactionDetailDto,
    toFactionMemberDto,
} from './dto/factions.dto';
import {
    CharacterDetailDto,
    LocationDetailDto,
    NpcDetailDto,
    toAffiliationDto,
    toLocationDetailDto,
    toNpcDetailDto,
} from './dto/details.dto';
import { toAlignmentDto } from './dto/party.dto';
import { parseSummaryData } from '../../bard/summaryData';
import {
    HISTORICAL_QUEST_AUDIT_MAX_TOOL_CALLS,
    HISTORICAL_QUEST_AUDIT_MAX_TOOL_RESULT_CHARS,
    HISTORICAL_QUEST_AUDIT_MAX_TURNS,
    prepareHistoricalQuestAudit,
    runHistoricalQuestAuditAgent,
} from '../../bard/agent/questLifecycle';
import { phaseConfigFor } from '../../bard/config';
import { scopeForCampaign } from '../../bard/ai/scope';
import { cloudObjectExists, getPresignedUrl } from '../../services/backup';
import {
    SessionDetailDto,
    SessionTranscriptDto,
} from './dto/sessions.dto';
import {
    PaginatedArtifactListDto,
    PaginatedBestiaryListDto,
    PaginatedCharacterListDto,
    PaginatedFactionListDto,
    PaginatedInventoryListDto,
    PaginatedLocationListDto,
    PaginatedNpcListDto,
    PaginatedQuestListDto,
    QuestListDto,
    PaginatedTimelineListDto,
    InventoryDetailDto,
    QuestLifecycleSuggestionDto,
    QuestAuditEstimateDto,
    QuestAuditStartDto,
    UpdateInventoryCategoryDto,
    toArtifactListDto,
    toBestiaryListDto,
    toCharacterListDto,
    toFactionListDto,
    toInventoryListDto,
    toInventoryDetailDto,
    toLocationListDto,
    toNpcListDto,
    toQuestListDto,
    toTimelineListDto,
} from './dto/entities.dto';
import {
    campaignRepository,
    characterRepository,
    npcRepository,
    locationRepository,
    factionRepository,
    questRepository,
    questLifecycleRepository,
    inventoryRepository,
    artifactRepository,
    bestiaryRepository,
    worldRepository,
    sessionRepository,
    recordingRepository,
    aiUsageRepository,
    tenantRepository,
} from '../../db';
import {
    INVENTORY_CATEGORIES,
    InventoryCategory,
    QuestStatus,
} from '../../db/types';
import { EntityMediaService } from './entityMedia.service';
import { MergeService } from './merge/merge.service';
import {
    DuplicatesResultDto,
    DuplicateMemberDto,
    MergeRequestDto,
    MergeResultDto,
    MergePreviewDto,
    MergePreviewRequestDto,
    MergeMembersRequestDto,
    MERGEABLE_ENTITY_TYPES,
    MergeableEntityType,
} from './dto/merge.dto';
import { assertMutationOrigin } from '../common/mutationOrigin';
import {
    canManageMembership,
    canWriteCampaign,
    getCampaignRole,
} from '../../services/campaignAccess';
import {
    buildEuroCostSnapshot,
    calculateActualAiCost,
    estimateAgentCost,
    getUsdEurRate,
    UNAVAILABLE_EXCHANGE_RATE,
    usdRangeToEur,
    type UsdEurRate,
} from '../../services/aiCostTransparency';
import { exchangeRateDto } from './dto/cost.dto';
import { buildQuestAuditTimeline, QuestAuditService } from './questAudit.service';

const AUDIO_URL_TTL_SECONDS = 5 * 60;

function sessionAudioKey(sessionId: string): string {
    return `recordings/${sessionId}/session_${sessionId}_master.mp3`;
}

function parseInventoryCategory(value: unknown): InventoryCategory {
    if (
        typeof value !== 'string' ||
        !INVENTORY_CATEGORIES.includes(value as InventoryCategory)
    ) {
        throw new BadRequestException(
            `category must be one of: ${INVENTORY_CATEGORIES.join(', ')}`,
        );
    }
    return value as InventoryCategory;
}

function parseMergeableEntityType(value: unknown): MergeableEntityType {
    if (
        typeof value !== 'string'
        || !MERGEABLE_ENTITY_TYPES.includes(value as MergeableEntityType)
    ) {
        throw new BadRequestException(`entityType must be one of: ${MERGEABLE_ENTITY_TYPES.join(', ')}`);
    }
    return value as MergeableEntityType;
}

/**
 * Read-only campaign data (roadmap 2.4).
 *
 * List endpoints return a `Page<T>` envelope of DTOs projected through
 * ./dto/projections.ts — never raw `SELECT *` rows, so plumbing columns cannot
 * leak and the OpenAPI document (web/openapi.json) can describe the shape.
 *
 * Detail endpoints still return repository rows as-is; they are next. Until
 * then, audit each one: `characters.email` is the known non-lore column and is
 * filtered to its owner in getCharacterDetail.
 */
/** Query shape for every list endpoint. */
interface ListQuery {
    limit?: string;
    offset?: string;
    sort?: string;
    dir?: string;
    q?: string;
    status?: string;
}

/**
 * Sortable columns per entity type.
 *
 * The values are literal SQL written here in the source; a request only ever
 * picks a key. An unknown key falls back to the default silently, so a stale
 * bookmark still renders.
 */
const SORTABLE: Record<string, Record<string, string>> = {
    npcs: { name: 'name', status: 'status', role: 'role', updated: 'last_updated' },
    locations: { region: 'macro_location', place: 'micro_location', updated: 'last_updated' },
    artifacts: { name: 'name', status: 'status', updated: 'last_updated' },
    bestiary: { name: 'name', status: 'status', lastSeen: 'last_seen' },
    // These two are sorted in memory, so the "SQL" here is just the field name.
    characters: { name: 'character_name', race: 'race', class: 'class' },
    factions: { name: 'name', type: 'type', status: 'status', reputation: 'reputation' },
};

interface WhisperSegment {
    text?: string;
}

function normalizeTranscriptionText(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('[')) return trimmed;
    try {
        const segments = JSON.parse(trimmed) as WhisperSegment[];
        if (!Array.isArray(segments)) return trimmed;
        return segments
            .map((segment) => segment.text?.trim())
            .filter((text): text is string => Boolean(text))
            .join(' ')
            .trim();
    } catch {
        return trimmed;
    }
}

@Controller('api/v1/campaigns')
@UseGuards(SessionGuard, CampaignAccessGuard)
export class CampaignsController {
    constructor(
        private readonly entityMedia: EntityMediaService,
        private readonly mergeService: MergeService,
        private readonly questAudits: QuestAuditService,
    ) {}

    @Get(':campaignId')
    getOverview(@Req() request: AuthenticatedRequest) {
        const campaignId = request.campaignId!;
        const campaign = campaignRepository.getCampaignById(campaignId)!;
        const location = campaignRepository.getCampaignLocationById(campaignId);
        const party = characterRepository.getCampaignCharacters(campaignId);
        const partyImages = this.entityMedia.getImages(
            campaignId,
            party.map((character) => ({ entityType: 'character', entityKey: character.user_id })),
        );
        const [lastSession] = sessionRepository.getAvailableSessions(undefined, campaignId, 1);
        const totalSessions = sessionRepository.getAvailableSessions(undefined, campaignId, 0).length;

        // The caller's role comes from the server, so the frontend does not have to
        // re-derive the permissions from the guild's `canManage`: they are two
        // different things (server administrator ≠ member of the table).
        const guildCanManage = request.guildAccess?.canManage ?? false;
        const userId = request.webSession.discordUserId;

        return {
            id: campaign.id,
            name: campaign.name,
            myRole: getCampaignRole(campaignId, userId),
            canWrite: canWriteCampaign(campaignId, userId, { guildCanManage }),
            canManageMembers: canManageMembership(campaignId, userId, { guildCanManage }),
            currentYear: campaign.current_year ?? null,
            currentLocation: location,
            partyAlignment: {
                moral: campaign.party_alignment_moral ?? null,
                ethical: campaign.party_alignment_ethical ?? null,
            },
            party: party.map((c) => ({
                userId: c.user_id,
                name: c.character_name,
                race: c.race,
                class: c.class,
                image: this.entityMedia.imageFromMap(partyImages, 'character', c.user_id),
            })),
            lastSession: lastSession ?? null,
            counts: {
                sessions: totalSessions,
                openQuests: questRepository.countOpenQuests(campaignId),
                npcs: npcRepository.countNpcs(campaignId),
                locations: locationRepository.countAtlasEntries(campaignId),
                factions: factionRepository.listFactions(campaignId).length,
                inventory: inventoryRepository.countInventory(campaignId),
                artifacts: artifactRepository.countArtifacts(campaignId),
                bestiary: bestiaryRepository.countMonsters(campaignId),
            },
        };
    }

    @Get(':campaignId/characters')
    @ApiOkResponse({ type: PaginatedCharacterListDto })
    getCharacters(@Req() request: AuthenticatedRequest, @Query() query: ListQuery) {
        // Sorted and searched in memory, not in SQL: a party is a handful of PCs,
        // and building a query for it would be complexity with nothing to buy.
        const pagination = parsePagination(query);
        const sort = parseSort(query, SORTABLE.characters, 'name');
        const campaignId = request.campaignId!;
        const source = characterRepository.getCampaignCharacters(campaignId);
        const images = this.entityMedia.getImages(
            campaignId,
            source.map((row) => ({ entityType: 'character', entityKey: row.user_id })),
        );
        const rows = source.map((row) =>
            toCharacterListDto(row, this.entityMedia.imageFromMap(images, 'character', row.user_id)),
        );
        const filtered = filterRows(rows, parseSearch(query), ['character_name', 'race', 'class']);
        return pageFromArray(sortRows(filtered, sort.orderBy.split(' ')[0], sort.direction), pagination);
    }

    // Characters have no short_id (see the web app's data map) — identified by Discord user id.
    @Get(':campaignId/characters/:userId')
    @ApiOkResponse({ type: CharacterDetailDto })
    getCharacterDetail(@Req() request: AuthenticatedRequest, @Param('userId') userId: string): CharacterDetailDto {
        const campaignId = request.campaignId!;
        const profile = characterRepository.getUserProfile(userId, campaignId);
        if (!profile.character_name) throw new NotFoundException('Character not found');

        const rowId = characterRepository.getCharacterRowId(userId, campaignId);
        const factions = rowId === null ? [] : factionRepository.getEntityFactions('pc', rowId).map(toAffiliationDto);

        const detail: CharacterDetailDto = {
            userId,
            character_name: profile.character_name,
            race: profile.race,
            class: profile.class,
            description: profile.description,
            foundation_description: profile.foundation_description,
            alignment: toAlignmentDto(profile.moral_score, profile.ethical_score),
            factions,
            image: this.entityMedia.getImage(campaignId, 'character', userId),
        };

        // email is the one non-lore column on characters: readable only by its owner.
        const isSelf = request.webSession.discordUserId === userId;
        return isSelf ? { ...detail, email: profile.email } : detail;
    }

    @Get(':campaignId/characters/:userId/events')
    @ApiOkResponse({ type: PaginatedHistoryEventDto })
    getCharacterEvents(
        @Req() request: AuthenticatedRequest,
        @Param('userId') userId: string,
        @Query() query: { limit?: string; offset?: string },
    ) {
        const profile = characterRepository.getUserProfile(userId, request.campaignId!);
        if (!profile.character_name) throw new NotFoundException('Character not found');
        const pagination = parsePagination(query);
        const history = characterRepository.getCharacterHistory(request.campaignId!, profile.character_name);
        return toEventPage(history, pagination);
    }

    @Get(':campaignId/npcs')
    @ApiOkResponse({ type: PaginatedNpcListDto })
    getNpcs(@Req() request: AuthenticatedRequest, @Query() query: ListQuery) {
        const pagination = parsePagination(query);
        const campaignId = request.campaignId!;
        const sort = parseSort(query, SORTABLE.npcs, 'updated');
        const search = parseSearch(query);
        // The count applies the same filter, or the footer would report the
        // unfiltered total while showing filtered rows.
        const opts = {
            orderBy: sort.orderBy,
            search: search ? { term: search, fields: ['name', 'role', 'description'] } : undefined,
        };
        const rows = npcRepository.listNpcs(campaignId, pagination.limit, pagination.offset, opts);
        const images = this.entityMedia.getImages(
            campaignId,
            rows.map((row) => ({ entityType: 'npc', entityKey: String(row.id) })),
        );
        return page(
            rows.map((row) => toNpcListDto(row, this.entityMedia.imageFromMap(images, 'npc', String(row.id)))),
            npcRepository.countNpcs(campaignId, opts),
            pagination,
        );
    }

    @Get(':campaignId/npcs/:shortId')
    @ApiOkResponse({ type: NpcDetailDto })
    getNpcDetail(@Req() request: AuthenticatedRequest, @Param('shortId') shortId: string) {
        const npc = npcRepository.getNpcByShortId(request.campaignId!, shortId);
        if (!npc) throw new NotFoundException('NPC not found');
        return toNpcDetailDto(
            npc,
            factionRepository.getEntityFactions('npc', npc.id).map(toAffiliationDto),
            this.entityMedia.getImage(request.campaignId!, 'npc', String(npc.id)),
        );
    }

    @Get(':campaignId/npcs/:shortId/events')
    @ApiOkResponse({ type: PaginatedHistoryEventDto })
    getNpcEvents(
        @Req() request: AuthenticatedRequest,
        @Param('shortId') shortId: string,
        @Query() query: { limit?: string; offset?: string },
    ) {
        const npc = npcRepository.getNpcByShortId(request.campaignId!, shortId);
        if (!npc) throw new NotFoundException('NPC not found');
        const pagination = parsePagination(query);
        return toEventPage(npcRepository.getNpcHistory(request.campaignId!, npc.name), pagination);
    }

    @Get(':campaignId/locations')
    @ApiOkResponse({ type: PaginatedLocationListDto })
    getLocations(@Req() request: AuthenticatedRequest, @Query() query: ListQuery) {
        const pagination = parsePagination(query);
        const campaignId = request.campaignId!;
        const sort = parseSort(query, SORTABLE.locations, 'updated');
        const search = parseSearch(query);
        const opts = {
            orderBy: sort.orderBy,
            search: search ? { term: search, fields: ['macro_location', 'micro_location', 'description'] } : undefined,
        };
        const rows = locationRepository.listAtlasEntries(campaignId, pagination.limit, pagination.offset, opts);
        const images = this.entityMedia.getImages(
            campaignId,
            rows.map((row) => ({ entityType: 'location', entityKey: String(row.id) })),
        );
        return page(
            rows.map((row) =>
                toLocationListDto(row, this.entityMedia.imageFromMap(images, 'location', String(row.id))),
            ),
            locationRepository.countAtlasEntries(campaignId, opts),
            pagination,
        );
    }

    @Get(':campaignId/locations/:shortId')
    @ApiOkResponse({ type: LocationDetailDto })
    getLocationDetail(@Req() request: AuthenticatedRequest, @Param('shortId') shortId: string) {
        const location = locationRepository.getAtlasEntryByShortId(request.campaignId!, shortId);
        if (!location) throw new NotFoundException('Location not found');
        return toLocationDetailDto(
            location,
            factionRepository.getEntityFactions('location', location.id).map(toAffiliationDto),
            this.entityMedia.getImage(request.campaignId!, 'location', String(location.id)),
        );
    }

    // A single location's travel log — who went there and when. Distinct from
    // /travels (campaign-wide) and from this location's narrative events:
    // atlas_history and location_history are different concepts.
    @Get(':campaignId/locations/:shortId/travels')
    getLocationTravels(
        @Req() request: AuthenticatedRequest,
        @Param('shortId') shortId: string,
        @Query() query: { limit?: string; offset?: string },
    ) {
        const location = locationRepository.getAtlasEntryByShortId(request.campaignId!, shortId);
        if (!location) throw new NotFoundException('Location not found');
        const pagination = parsePagination(query);
        const rows = locationRepository.getLocationTravelLog(
            request.campaignId!,
            location.macro_location,
            location.micro_location,
        );
        return pageFromArray(rows, pagination);
    }

    // Narrative events for this atlas entry — NOT the raw travel log (see /travels below,
    // a campaign-wide, different table: the web app's data map).
    @Get(':campaignId/locations/:shortId/events')
    @ApiOkResponse({ type: PaginatedHistoryEventDto })
    getLocationEvents(
        @Req() request: AuthenticatedRequest,
        @Param('shortId') shortId: string,
        @Query() query: { limit?: string; offset?: string },
    ) {
        const location = locationRepository.getAtlasEntryByShortId(request.campaignId!, shortId);
        if (!location) throw new NotFoundException('Location not found');
        const pagination = parsePagination(query);
        const history = locationRepository.getAtlasHistory(request.campaignId!, location.macro_location, location.micro_location);
        return toEventPage(history, pagination);
    }

    // Campaign-wide chronological travel/visit log ($travels bot command) — distinct from
    // the per-location narrative events above.
    @Get(':campaignId/travels')
    getTravels(@Req() request: AuthenticatedRequest, @Query() query: { limit?: string }) {
        const { limit } = parsePagination(query);
        return locationRepository.getLocationHistoryWithIds(request.campaignId!, limit);
    }

    @Get(':campaignId/factions')
    @ApiOkResponse({ type: PaginatedFactionListDto })
    getFactions(@Req() request: AuthenticatedRequest, @Query() query: ListQuery) {
        // No DB-level pagination: factions rarely number more than a couple dozen per
        // campaign. Still enveloped so the SPA has a single list-handling path.
        const pagination = parsePagination(query);
        // Joined with reputation so a list of factions can show the party's
        // standing without an N+1 of getFactionReputation. Sorted in memory:
        // a campaign has dozens of factions at most.
        const sort = parseSort(query, SORTABLE.factions, 'name');
        const rows = factionRepository.listFactionsWithReputation(request.campaignId!).map(toFactionListDto);
        const filtered = filterRows(rows, parseSearch(query), ['name', 'description', 'type']);
        return pageFromArray(sortRows(filtered, sort.orderBy.split(' ')[0], sort.direction), pagination);
    }

    @Get(':campaignId/factions/:shortId')
    @ApiOkResponse({ type: FactionDetailDto })
    getFactionDetail(@Req() request: AuthenticatedRequest, @Param('shortId') shortId: string) {
        const campaignId = request.campaignId!;
        const faction = factionRepository.getFactionByShortId(campaignId, shortId);
        if (!faction) throw new NotFoundException('Faction not found');
        return toFactionDetailDto(
            faction,
            factionRepository.getFactionReputation(campaignId, faction.id),
            factionRepository.countFactionMembers(faction.id),
        );
    }

    @Get(':campaignId/factions/:shortId/members')
    @ApiOkResponse({ type: PaginatedFactionMemberDto })
    getFactionMembers(
        @Req() request: AuthenticatedRequest,
        @Param('shortId') shortId: string,
        @Query() query: { limit?: string; offset?: string },
    ) {
        const faction = factionRepository.getFactionByShortId(request.campaignId!, shortId);
        if (!faction) throw new NotFoundException('Faction not found');
        const pagination = parsePagination(query);
        const rows = factionRepository.listFactionMembersDetailed(faction.id).map(toFactionMemberDto);
        return pageFromArray(rows, pagination);
    }

    @Get(':campaignId/factions/:shortId/events')
    @ApiOkResponse({ type: PaginatedHistoryEventDto })
    getFactionEvents(
        @Req() request: AuthenticatedRequest,
        @Param('shortId') shortId: string,
        @Query() query: { limit?: string; offset?: string },
    ) {
        const faction = factionRepository.getFactionByShortId(request.campaignId!, shortId);
        if (!faction) throw new NotFoundException('Faction not found');
        const pagination = parsePagination(query);
        return toEventPage(factionRepository.getFactionHistory(request.campaignId!, faction.name), pagination);
    }

    @Get(':campaignId/quests')
    @ApiOkResponse({ type: PaginatedQuestListDto })
    getQuests(
        @Req() request: AuthenticatedRequest,
        @Query() query: { limit?: string; offset?: string; status?: string },
    ) {
        const pagination = parsePagination(query);
        const campaignId = request.campaignId!;
        const status = query.status ?? 'ALL';
        const rows = questRepository.getQuestsByStatus(campaignId, status, pagination.limit, pagination.offset);
        return page(
            rows.map(toQuestListDto),
            questRepository.countQuestsByStatus(campaignId, status),
            pagination,
        );
    }

    // Quest create/update/delete have moved to the unified CRUD
    // (crud/entity-crud.controller.ts): same validation and same delete cascade
    // as the other seven families.

    @Get(':campaignId/quests/lifecycle-suggestions')
    @ApiOkResponse({ type: [QuestLifecycleSuggestionDto] })
    @ApiForbiddenResponse({ description: 'Campaign management permission is required.' })
    getQuestLifecycleSuggestions(
        @Req() request: AuthenticatedRequest,
        @Query() query: { status?: 'PENDING' | 'APPLIED' | 'DISMISSED' | 'ALL' },
    ) {
        const allowed = ['PENDING', 'APPLIED', 'DISMISSED', 'ALL'];
        const status = allowed.includes(String(query.status || 'PENDING').toUpperCase())
            ? String(query.status || 'PENDING').toUpperCase() as 'PENDING' | 'APPLIED' | 'DISMISSED' | 'ALL'
            : 'PENDING';
        return questLifecycleRepository.listSuggestions(request.campaignId!, status);
    }

    @Get(':campaignId/quests/lifecycle-audit/estimate')
    @UseGuards(CampaignWriteGuard)
    @ApiOkResponse({ type: QuestAuditEstimateDto })
    @ApiForbiddenResponse({ description: 'Campaign management permission is required.' })
    async estimateQuestLifecycleAudit(
        @Req() request: AuthenticatedRequest,
    ): Promise<QuestAuditEstimateDto> {
        const campaignId = request.campaignId!;
        const { sessions, timeline } = buildQuestAuditTimeline(campaignId);
        const openQuestCount = questRepository.getOpenQuests(campaignId, 30, 0).length;
        const pendingSuggestionCount =
            questLifecycleRepository.listSuggestions(campaignId, 'PENDING').length;
        const cooldownEndsAt = this.questAudits.cooldownEndsAt(campaignId);
        // The TABLE's provider and model: the estimate tells the user what they will
        // spend on their own account, so it must name the model they will use.
        const analyst = phaseConfigFor('analyst', scopeForCampaign(campaignId));
        const common = {
            provider: analyst.provider,
            model: analyst.model,
            session_count: sessions.length,
            open_quest_count: openQuestCount,
            pending_suggestion_count: pendingSuggestionCount,
        };
        const noCostEstimate = (
            status: 'RUNNING' | 'COOLDOWN' | 'NO_SESSIONS' | 'NOTHING_TO_AUDIT',
            cooldown: number | null,
        ): QuestAuditEstimateDto => ({
            status,
            will_invoke_ai: false,
            billable: false,
            pricing_available: true,
            ...common,
            estimated_tokens: null,
            estimated_cost_usd: null,
            estimated_cost_eur: null,
            exchange_rate: exchangeRateDto(UNAVAILABLE_EXCHANGE_RATE),
            cooldown_ends_at: cooldown,
        });

        const skip = this.questAudits.skipReason(campaignId);
        if (skip) return noCostEstimate(skip, skip === 'COOLDOWN' ? cooldownEndsAt : null);

        const prepared = prepareHistoricalQuestAudit({ campaignId, timelineText: timeline });
        const estimate = estimateAgentCost({
            provider: analyst.provider,
            model: analyst.model,
            systemPromptChars: prepared.systemPrompt.length,
            userPromptChars: prepared.userPrompt.length,
            toolSchemaChars: prepared.toolSchemaChars,
            subjectCount: prepared.openQuestCount,
            maxTurns: HISTORICAL_QUEST_AUDIT_MAX_TURNS,
            maxToolCalls: HISTORICAL_QUEST_AUDIT_MAX_TOOL_CALLS,
            maxToolResultChars: HISTORICAL_QUEST_AUDIT_MAX_TOOL_RESULT_CHARS,
        });
        const exchangeRate = estimate.billable && estimate.costUsd
            ? await getUsdEurRate()
            : UNAVAILABLE_EXCHANGE_RATE;
        return {
            status: 'READY',
            will_invoke_ai: true,
            billable: estimate.billable,
            pricing_available: estimate.pricingAvailable,
            ...common,
            open_quest_count: prepared.openQuestCount,
            estimated_tokens: {
                input_min: estimate.tokens.inputMin,
                input_max: estimate.tokens.inputMax,
                output_min: estimate.tokens.outputMin,
                output_max: estimate.tokens.outputMax,
            },
            estimated_cost_usd: estimate.costUsd,
            estimated_cost_eur: usdRangeToEur(estimate.costUsd, exchangeRate),
            exchange_rate: exchangeRateDto(exchangeRate),
            cooldown_ends_at: null,
        };
    }

    /**
     * Starts an audit of the campaign's open quests.
     *
     * **202 with a job id**, because this is an agent reading every session
     * summary the table has: minutes of work on the table's own account, which
     * must not depend on a browser staying connected. The proposals it makes
     * still land in `quest_lifecycle_suggestions` and are still accepted or
     * dismissed one by one — this route tracks the run, not the decisions.
     */
    @Post(':campaignId/quests/lifecycle-audit')
    @HttpCode(202)
    @UseGuards(CampaignWriteGuard)
    @ApiAcceptedResponse({ type: QuestAuditStartDto })
    @ApiBadRequestResponse({ description: 'No historical session summaries are available.' })
    @ApiConflictResponse({ description: 'A quest history audit is already running for this campaign.' })
    @ApiForbiddenResponse({ description: 'Campaign management permission is required.' })
    auditQuestLifecycle(@Req() request: AuthenticatedRequest): QuestAuditStartDto {
        assertMutationOrigin(request);
        const { jobId, skipped } = this.questAudits.enqueue(request);
        return {
            job_id: jobId,
            invoked_ai: jobId !== null,
            skipped_reason: skipped as QuestAuditStartDto['skipped_reason'],
        };
    }

    @Post(':campaignId/quests/lifecycle-suggestions/:suggestionId/apply')
    @UseGuards(CampaignWriteGuard)
    @ApiOkResponse({ type: QuestLifecycleSuggestionDto })
    applyQuestLifecycleSuggestion(
        @Req() request: AuthenticatedRequest,
        @Param('suggestionId') suggestionId: string,
    ) {
        assertMutationOrigin(request);
        const campaignId = request.campaignId!;
        const id = Number(suggestionId);
        const suggestion = Number.isInteger(id)
            ? questLifecycleRepository.getSuggestion(campaignId, id)
            : null;
        if (!suggestion || suggestion.status !== 'PENDING') {
            throw new NotFoundException('Pending quest lifecycle suggestion not found');
        }

        try {
            if (suggestion.proposed_action === 'CREATE') {
                questRepository.createManualQuest(campaignId, {
                    title: suggestion.proposed_title,
                    description: suggestion.proposed_description,
                    status: suggestion.proposed_status,
                    type: suggestion.proposed_type,
                    sessionId: suggestion.session_id
                });
            } else {
                const quest = suggestion.quest_id == null
                    ? null
                    : questRepository.getQuestById(campaignId, suggestion.quest_id);
                if (!quest) throw new Error('Quest target not found');
                if (
                    (quest.status === QuestStatus.COMPLETED || quest.status === QuestStatus.FAILED) &&
                    quest.status !== suggestion.proposed_status
                ) {
                    throw new Error('The quest has already reached a different terminal status');
                }
                questRepository.updateQuestStatusById(quest.id, suggestion.proposed_status);
                questRepository.addQuestEvent(
                    campaignId,
                    quest.title,
                    suggestion.session_id || '',
                    suggestion.proposed_description || suggestion.evidence,
                    'MANUAL_UPDATE',
                    true
                );
            }
            return questLifecycleRepository.resolveSuggestion(campaignId, id, 'APPLIED');
        } catch (error: any) {
            throw new BadRequestException(error?.message || 'Unable to apply suggestion');
        }
    }

    @Post(':campaignId/quests/lifecycle-suggestions/:suggestionId/dismiss')
    @UseGuards(CampaignWriteGuard)
    @ApiOkResponse({ type: QuestLifecycleSuggestionDto })
    dismissQuestLifecycleSuggestion(
        @Req() request: AuthenticatedRequest,
        @Param('suggestionId') suggestionId: string,
    ) {
        assertMutationOrigin(request);
        const id = Number(suggestionId);
        const suggestion = Number.isInteger(id)
            ? questLifecycleRepository.resolveSuggestion(request.campaignId!, id, 'DISMISSED')
            : null;
        if (!suggestion) throw new NotFoundException('Pending quest lifecycle suggestion not found');
        return suggestion;
    }

    @Get(':campaignId/quests/:shortId')
    getQuestDetail(@Req() request: AuthenticatedRequest, @Param('shortId') shortId: string) {
        const quest = questRepository.getQuestByShortId(request.campaignId!, shortId);
        if (!quest) throw new NotFoundException('Quest not found');
        return quest;
    }

    @Get(':campaignId/quests/:shortId/events')
    @ApiOkResponse({ type: PaginatedHistoryEventDto })
    getQuestEvents(
        @Req() request: AuthenticatedRequest,
        @Param('shortId') shortId: string,
        @Query() query: { limit?: string; offset?: string },
    ) {
        const quest = questRepository.getQuestByShortId(request.campaignId!, shortId);
        if (!quest) throw new NotFoundException('Quest not found');
        const pagination = parsePagination(query);
        return toEventPage(questRepository.getQuestHistory(request.campaignId!, quest.title), pagination);
    }

    @Get(':campaignId/inventory')
    @ApiOkResponse({ type: PaginatedInventoryListDto })
    @ApiQuery({ name: 'category', required: false, enum: INVENTORY_CATEGORIES })
    getInventory(
        @Req() request: AuthenticatedRequest,
        @Query() query: { limit?: string; offset?: string; category?: string },
    ) {
        const pagination = parsePagination(query);
        const campaignId = request.campaignId!;
        const category = query.category === undefined
            ? undefined
            : parseInventoryCategory(query.category);
        const rows = inventoryRepository.getInventoryWithArtifactInfo(
            campaignId,
            pagination.limit,
            pagination.offset,
            category,
        );
        const artifactImages = this.entityMedia.getImages(
            campaignId,
            rows
                .filter((row) => row.artifact_id !== null)
                .map((row) => ({ entityType: 'artifact', entityKey: String(row.artifact_id) })),
        );
        return page(
            rows.map((row) =>
                toInventoryListDto(
                    row,
                    row.artifact_id === null
                        ? null
                        : this.entityMedia.imageFromMap(artifactImages, 'artifact', String(row.artifact_id)),
                ),
            ),
            inventoryRepository.countInventory(campaignId, category),
            pagination,
        );
    }

    @Get(':campaignId/inventory/:shortId')
    @ApiOkResponse({ type: InventoryDetailDto })
    getInventoryItemDetail(@Req() request: AuthenticatedRequest, @Param('shortId') shortId: string) {
        const item = inventoryRepository.getInventoryItemWithArtifactInfoByShortId(
            request.campaignId!,
            shortId,
        );
        if (!item) throw new NotFoundException('Inventory item not found');
        return toInventoryDetailDto(
            item,
            item.artifact_id === null
                ? null
                : this.entityMedia.getImage(request.campaignId!, 'artifact', String(item.artifact_id)),
        );
    }

    @Patch(':campaignId/inventory/:shortId/category')
    @UseGuards(CampaignWriteGuard)
    @ApiOkResponse({ type: InventoryDetailDto })
    @ApiBadRequestResponse({ description: 'The category is missing or is not a supported enum value.' })
    @ApiForbiddenResponse({ description: 'Campaign management permission is required.' })
    updateInventoryItemCategory(
        @Req() request: AuthenticatedRequest,
        @Param('shortId') shortId: string,
        @Body() body: UpdateInventoryCategoryDto,
    ) {
        const category = parseInventoryCategory(body?.category);
        const campaignId = request.campaignId!;
        const item = inventoryRepository.getInventoryItemByShortId(campaignId, shortId);
        if (!item) throw new NotFoundException('Inventory item not found');

        inventoryRepository.updateInventoryCategory(campaignId, shortId, category);
        const updated = inventoryRepository.getInventoryItemWithArtifactInfoByShortId(
            campaignId,
            shortId,
        );
        if (!updated) throw new NotFoundException('Inventory item not found');
        return toInventoryDetailDto(
            updated,
            updated.artifact_id === null
                ? null
                : this.entityMedia.getImage(campaignId, 'artifact', String(updated.artifact_id)),
        );
    }

    @Get(':campaignId/inventory/:shortId/events')
    @ApiOkResponse({ type: PaginatedHistoryEventDto })
    getInventoryItemEvents(
        @Req() request: AuthenticatedRequest,
        @Param('shortId') shortId: string,
        @Query() query: { limit?: string; offset?: string },
    ) {
        const item = inventoryRepository.getInventoryItemByShortId(request.campaignId!, shortId);
        if (!item) throw new NotFoundException('Inventory item not found');
        const pagination = parsePagination(query);
        return toEventPage(inventoryRepository.getInventoryHistory(request.campaignId!, item.item_name), pagination);
    }

    @Get(':campaignId/artifacts')
    @ApiOkResponse({ type: PaginatedArtifactListDto })
    getArtifacts(@Req() request: AuthenticatedRequest, @Query() query: ListQuery) {
        const pagination = parsePagination(query);
        const campaignId = request.campaignId!;
        const sort = parseSort(query, SORTABLE.artifacts, 'updated');
        const search = parseSearch(query);
        const opts = {
            orderBy: sort.orderBy,
            search: search ? { term: search, fields: ['name', 'description'] } : undefined,
        };
        const rows = artifactRepository.listArtifacts(campaignId, pagination.limit, pagination.offset, opts);
        const images = this.entityMedia.getImages(
            campaignId,
            rows.map((row) => ({ entityType: 'artifact', entityKey: String(row.id) })),
        );
        return page(
            rows.map((row) =>
                toArtifactListDto(row, this.entityMedia.imageFromMap(images, 'artifact', String(row.id))),
            ),
            artifactRepository.countArtifacts(campaignId, opts),
            pagination,
        );
    }

    @Get(':campaignId/artifacts/:shortId')
    getArtifactDetail(@Req() request: AuthenticatedRequest, @Param('shortId') shortId: string) {
        const artifact = artifactRepository.getArtifactByShortId(request.campaignId!, shortId);
        if (!artifact) throw new NotFoundException('Artifact not found');
        return toArtifactListDto(
            artifact,
            this.entityMedia.getImage(request.campaignId!, 'artifact', String(artifact.id)),
        );
    }

    @Get(':campaignId/artifacts/:shortId/events')
    @ApiOkResponse({ type: PaginatedHistoryEventDto })
    getArtifactEvents(
        @Req() request: AuthenticatedRequest,
        @Param('shortId') shortId: string,
        @Query() query: { limit?: string; offset?: string },
    ) {
        const artifact = artifactRepository.getArtifactByShortId(request.campaignId!, shortId);
        if (!artifact) throw new NotFoundException('Artifact not found');
        const pagination = parsePagination(query);
        return toEventPage(artifactRepository.getArtifactHistory(request.campaignId!, artifact.name), pagination);
    }

    // --- DUPLICATE MERGE (Artifacts + NPCs + Factions) ---
    // A dedicated /merge/:entityType namespace to avoid routing collisions with
    // :campaignId/{npcs|artifacts|factions}/:shortId (a static `merge` segment in position 2).

    @Get(':campaignId/merge/:entityType/duplicates')
    @ApiOkResponse({ type: DuplicatesResultDto })
    @ApiBadRequestResponse({ description: 'entityType must be one of: artifacts, npcs, factions.' })
    @ApiQuery({ name: 'semantic', required: false, description: '1 = include embedding-based semantic dup detection.' })
    getDuplicateClusters(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Query('semantic') semantic?: string,
    ): Promise<DuplicatesResultDto> {
        const type = parseMergeableEntityType(entityType);
        return this.mergeService.findDuplicates(request.campaignId!, type, semantic === '1');
    }

    @Post(':campaignId/merge/:entityType/members')
    @HttpCode(200)
    @UseGuards(CampaignWriteGuard)
    @ApiOkResponse({ type: DuplicateMemberDto, isArray: true })
    @ApiBadRequestResponse({ description: 'entityType must be one of: artifacts, npcs, factions.' })
    @ApiForbiddenResponse({ description: 'Campaign management permission is required.' })
    getMergeMembers(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Body() body: MergeMembersRequestDto,
    ): Promise<DuplicateMemberDto[]> {
        const type = parseMergeableEntityType(entityType);
        return this.mergeService.getMembers(request.campaignId!, type, body.short_ids ?? []);
    }

    @Post(':campaignId/merge/:entityType')
    @HttpCode(200)
    @UseGuards(CampaignWriteGuard)
    @ApiOkResponse({ type: MergeResultDto })
    @ApiBadRequestResponse({ description: 'Missing/invalid keep_short_id or drop_short_ids.' })
    @ApiForbiddenResponse({ description: 'Campaign management permission is required.' })
    @ApiConflictResponse({ description: 'Manual drop not confirmed, or final_name already used by an unselected entity.' })
    @ApiNotFoundResponse({ description: 'Survivor or drop entity not found.' })
    mergeDuplicates(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Body() body: MergeRequestDto,
    ): Promise<MergeResultDto> {
        assertMutationOrigin(request);
        const type = parseMergeableEntityType(entityType);
        return this.mergeService.mergeEntities(request.campaignId!, type, body.keep_short_id, body.drop_short_ids, {
            description: body.description,
            autoMergeDescription: body.auto_merge_description,
            confirmManualMerge: body.confirm_manual_merge,
            finalName: body.final_name,
        });
    }

    @Post(':campaignId/merge/:entityType/preview')
    @HttpCode(200)
    @UseGuards(CampaignWriteGuard)
    @ApiOkResponse({ type: MergePreviewDto })
    @ApiBadRequestResponse({ description: 'Missing/invalid keep_short_id or drop_short_ids.' })
    @ApiNotFoundResponse({ description: 'Survivor entity not found.' })
    @ApiConflictResponse({ description: 'The requested final_name is already used by an unselected entity.' })
    @ApiForbiddenResponse({ description: 'Campaign management permission is required.' })
    previewMerge(
        @Req() request: AuthenticatedRequest,
        @Param('entityType') entityType: string,
        @Body() body: MergePreviewRequestDto,
    ): Promise<MergePreviewDto> {
        const type = parseMergeableEntityType(entityType);
        return this.mergeService.previewMerge(
            request.campaignId!,
            type,
            body.keep_short_id,
            body.drop_short_ids,
            body.final_name,
            body.description,
        );
    }

    @Get(':campaignId/bestiary')
    @ApiOkResponse({ type: PaginatedBestiaryListDto })
    getBestiary(@Req() request: AuthenticatedRequest, @Query() query: ListQuery) {
        const pagination = parsePagination(query);
        const campaignId = request.campaignId!;
        const sort = parseSort(query, SORTABLE.bestiary, 'lastSeen');
        const search = parseSearch(query);
        // The GROUP BY name must reach the count too: without it the total counts
        // duplicate rows and the footer promises pages that do not exist.
        const opts = {
            orderBy: sort.orderBy,
            search: search ? { term: search, fields: ['name'] } : undefined,
        };
        const rows = bestiaryRepository.listMonsters(campaignId, pagination.limit, pagination.offset, opts);
        return page(rows.map(toBestiaryListDto), bestiaryRepository.countMonsters(campaignId, opts), pagination);
    }

    @Get(':campaignId/bestiary/:shortId')
    getBestiaryDetail(@Req() request: AuthenticatedRequest, @Param('shortId') shortId: string) {
        const monster = bestiaryRepository.getMonsterByShortId(request.campaignId!, shortId);
        if (!monster) throw new NotFoundException('Bestiary entry not found');
        return monster;
    }

    @Get(':campaignId/bestiary/:shortId/events')
    @ApiOkResponse({ type: PaginatedHistoryEventDto })
    getBestiaryEvents(
        @Req() request: AuthenticatedRequest,
        @Param('shortId') shortId: string,
        @Query() query: { limit?: string; offset?: string },
    ) {
        const monster = bestiaryRepository.getMonsterByShortId(request.campaignId!, shortId);
        if (!monster) throw new NotFoundException('Bestiary entry not found');
        const pagination = parsePagination(query);
        return toEventPage(bestiaryRepository.getBestiaryHistory(request.campaignId!, monster.name), pagination);
    }

    @Get(':campaignId/timeline')
    @ApiOkResponse({ type: PaginatedTimelineListDto })
    getTimeline(@Req() request: AuthenticatedRequest, @Query() query: { limit?: string; offset?: string }) {
        // Still sliced in memory: getWorldTimeline returns the whole ledger. DB-level
        // pagination is a Fase 2 repository addition (getWorldTimelinePage).
        const pagination = parsePagination(query);
        const rows = worldRepository.getWorldTimeline(request.campaignId!);
        return pageFromArray(rows.map(toTimelineListDto), pagination);
    }

    // Timeline has no "history of a history": each row already IS a complete
    // event (see the web app's data map) — this is a single-event permalink.
    @Get(':campaignId/timeline/:shortId')
    getTimelineEventDetail(@Req() request: AuthenticatedRequest, @Param('shortId') shortId: string) {
        const event = worldRepository.getWorldEventByShortId(request.campaignId!, shortId);
        if (!event) throw new NotFoundException('Timeline event not found');
        return event;
    }

    @Get(':campaignId/sessions')
    getSessions(@Req() request: AuthenticatedRequest, @Query() query: { limit?: string; offset?: string }) {
        const pagination = parsePagination(query);
        const campaignId = request.campaignId!;
        const rows = sessionRepository.getAvailableSessions(undefined, campaignId, pagination.limit, pagination.offset);
        // limit 0 means "all": the only way to count today, and the same full scan the
        // overview already does. A dedicated countSessions belongs with the next
        // SessionRepository change.
        const total = sessionRepository.getAvailableSessions(undefined, campaignId, 0).length;
        return page(rows, total, pagination);
    }

    @Get(':campaignId/sessions/:sessionId/transcript')
    @ApiParam({ name: 'campaignId', type: Number })
    @ApiOkResponse({ type: SessionTranscriptDto })
    @ApiNotFoundResponse({ description: 'Session not found in this campaign.' })
    getSessionTranscript(
        @Req() request: AuthenticatedRequest,
        @Param('sessionId') sessionId: string,
    ): SessionTranscriptDto {
        if (!sessionRepository.belongsToCampaign(sessionId, request.campaignId!)) {
            throw new NotFoundException('Session not found');
        }

        return {
            items: recordingRepository.getSessionTranscript(sessionId).map((entry) => ({
                text: normalizeTranscriptionText(entry.transcription_text!),
                userId: entry.user_id ?? null,
                characterName: entry.character_name,
                timestamp: entry.timestamp,
                macroLocation: entry.macro_location ?? null,
                microLocation: entry.micro_location ?? null,
            })),
        };
    }

    @Get(':campaignId/sessions/:sessionId/audio')
    @ApiParam({ name: 'campaignId', type: Number })
    @ApiFoundResponse({ description: 'Redirects to a short-lived signed URL for the session master.' })
    @ApiNotFoundResponse({ description: 'Session or master audio not found.' })
    async getSessionAudio(
        @Req() request: AuthenticatedRequest,
        @Param('sessionId') sessionId: string,
        @Res() reply: FastifyReply,
    ) {
        if (!sessionRepository.belongsToCampaign(sessionId, request.campaignId!)) {
            throw new NotFoundException('Session not found');
        }

        const url = await getPresignedUrl(sessionAudioKey(sessionId), undefined, AUDIO_URL_TTL_SECONDS);
        if (!url) throw new NotFoundException('Session audio not found');
        return reply.redirect(url, 302);
    }

    @Get(':campaignId/sessions/:sessionId')
    @ApiParam({ name: 'campaignId', type: Number })
    @ApiOkResponse({ type: SessionDetailDto })
    @ApiNotFoundResponse({ description: 'Session not found in this campaign.' })
    async getSessionDetail(
        @Req() request: AuthenticatedRequest,
        @Param('sessionId') sessionId: string,
    ): Promise<SessionDetailDto> {
        const sessions = sessionRepository.getAvailableSessions(undefined, request.campaignId!, 0);
        const session = sessions.find((s) => s.session_id === sessionId);
        if (!session) throw new NotFoundException('Session not found');

        // The bot's own $sessionlist detail view shows only `brief`; the web
        // dashboard also exposes the full `narrative` (the web app's data map)
        // plus the generation metadata, which the bot never surfaces anywhere.
        const aiOutput = sessionRepository.getSessionAIOutput(sessionId);
        const summary = parseSummaryData(aiOutput?.summaryData);

        // Cross-references: what this session actually produced. All from getters
        // that already exist, keyed by session_id.
        //
        // session_notes has no campaign_id column, so the ownership check above
        // (the session must belong to this campaign) is what scopes it — it has
        // to stay before this point.
        const transcript = recordingRepository.getSessionTranscript(sessionId);
        const sessionNpcs = npcRepository.getSessionEncounteredNPCs(sessionId);
        const sessionInventory = inventoryRepository.getSessionInventoryWithArtifactInfo(sessionId);
        const sessionParticipants = sessionRepository.getSessionParticipants(sessionId);
        const referenceImages = this.entityMedia.getImages(request.campaignId!, [
            ...sessionNpcs.map((npc) => ({ entityType: 'npc' as const, entityKey: String(npc.id) })),
            ...sessionInventory
                .filter((item) => item.artifact_id !== null)
                .map((item) => ({ entityType: 'artifact' as const, entityKey: String(item.artifact_id) })),
            ...sessionParticipants.map((participant) => ({
                entityType: 'character' as const,
                entityKey: participant.user_id,
            })),
        ]);
        return {
            ...session,
            campaign_name: session.campaign_name ?? null,
            campaign_id: session.campaign_id!,
            session_number: session.session_number ?? null,
            title: session.title ?? null,
            brief: summary?.brief ?? null,
            narrative: summary?.narrative ?? null,
            metadata: summary?.metadata ?? null,
            notes: sessionRepository.getSessionNotes(sessionId).map((note) => ({
                id: note.id,
                session_id: note.session_id,
                user_id: note.user_id ?? null,
                content: note.content,
                timestamp: note.timestamp ?? null,
                created_at: note.created_at ?? null,
                macro_location: note.macro_location ?? null,
                micro_location: note.micro_location ?? null,
            })),
            npcsEncountered: sessionNpcs.map((npc) => ({
                short_id: npc.short_id ?? null,
                name: npc.name,
                role: npc.role,
                status: npc.status,
                image: this.entityMedia.imageFromMap(referenceImages, 'npc', String(npc.id)),
            })),
            quests: questRepository
                .getSessionQuests(sessionId)
                .map((quest: any) => ({ short_id: quest.short_id ?? null, title: quest.title, status: quest.status })),
            inventory: sessionInventory.map((item) => ({
                    short_id: item.short_id ?? null,
                    item_name: item.item_name,
                    quantity: item.quantity,
                    category: item.category,
                    image:
                        item.artifact_id === null
                            ? null
                            : this.entityMedia.imageFromMap(
                                  referenceImages,
                                  'artifact',
                                  String(item.artifact_id),
                              ),
                })),
            bestiary: bestiaryRepository
                .getSessionMonsters(sessionId)
                .map((monster) => ({ short_id: monster.short_id ?? null, name: monster.name, status: monster.status })),
            travels: locationRepository.getSessionTravelLog(sessionId),
            navigation: sessionRepository.getSessionNavigation(request.campaignId!, sessionId),
            participants: sessionParticipants.map((participant) => ({
                userId: participant.user_id,
                characterName: participant.character_name,
                image: this.entityMedia.imageFromMap(referenceImages, 'character', participant.user_id),
            })),
            media: {
                audioAvailable: await cloudObjectExists(sessionAudioKey(sessionId)),
                transcriptAvailable: transcript.length > 0,
            },
        };
    }
}
