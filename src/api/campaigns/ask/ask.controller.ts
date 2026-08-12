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
} from '@nestjs/swagger';
import { SessionGuard } from '../../auth/session.guard';
import { AuthenticatedRequest } from '../../auth/types';
import { CampaignAccessGuard } from '../campaignAccess.guard';
import { CampaignWriteGuard } from '../campaignWrite.guard';
import { assertMutationOrigin } from '../../common/mutationOrigin';
import { page, parsePagination } from '../../common/pagination';
import {
    AskAnswerDto,
    AskConversationDetailDto,
    AskConversationDto,
    AskConversationPatchDto,
    AskEstimateDto,
    AskQuestionBodyDto,
    PaginatedAskConversationDto,
} from './ask.dto';
import { ASK_QUESTION_MAX_CHARS, ASK_TITLE_MAX_CHARS, AskService } from './ask.service';

function parseConversationId(value: string): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('conversationId must be a positive integer');
    return id;
}

function parseQuestion(body: AskQuestionBodyDto): string {
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (question.length === 0) throw new BadRequestException('question must not be empty');
    if (question.length > ASK_QUESTION_MAX_CHARS) {
        throw new BadRequestException(`question must be at most ${ASK_QUESTION_MAX_CHARS} characters`);
    }
    return question;
}

/**
 * Conversations with the Bardo from the web app: the counterpart of `$ask` on Discord.
 *
 * It lives in a separate controller and is registered BEFORE `EntityCrudController`:
 * that one routes on `:campaignId/:entityType/...` and would intercept
 * these routes if it were evaluated first.
 *
 * `CampaignWriteGuard` on the mutations only, for the reason already written in
 * the guard: the spend belongs to the table, and members of the table can
 * authorize it. Reading a shared conversation is consultation instead.
 */
@Controller('api/v1/campaigns')
@UseGuards(SessionGuard, CampaignAccessGuard)
export class AskController {
    constructor(private readonly ask: AskService) {}

    /**
     * Estimate for the exchange, without invoking the model.
     *
     * Feeds the always-visible cost line above the composer: the price has to be
     * read before sending, not discovered afterwards with a 402.
     */
    @Get(':campaignId/ask/estimate')
    @ApiOkResponse({ type: AskEstimateDto })
    estimate(@Req() request: AuthenticatedRequest): Promise<AskEstimateDto> {
        return this.ask.estimate(request.campaignId!, request.webSession.discordUserId);
    }

    @Get(':campaignId/ask/conversations')
    @ApiOkResponse({ type: PaginatedAskConversationDto })
    list(
        @Req() request: AuthenticatedRequest,
        @Query() query: { limit?: string; offset?: string },
    ) {
        const pagination = parsePagination(query);
        const { items, total } = this.ask.listConversations(
            request.campaignId!,
            request.webSession.discordUserId,
            pagination.limit,
            pagination.offset,
        );
        return page(items, total, pagination);
    }

    @Get(':campaignId/ask/conversations/:conversationId')
    @ApiOkResponse({ type: AskConversationDetailDto })
    @ApiForbiddenResponse({ description: 'This conversation is private.' })
    @ApiNotFoundResponse({ description: 'No such conversation in this campaign.' })
    detail(
        @Req() request: AuthenticatedRequest,
        @Param('conversationId') rawId: string,
    ): AskConversationDetailDto {
        const userId = request.webSession.discordUserId;
        const conversation = this.ask.readable(request.campaignId!, userId, parseConversationId(rawId));
        const messages = this.ask.messages(conversation.id);
        return {
            id: conversation.id,
            title: conversation.title,
            shared: conversation.shared === 1,
            owned: conversation.user_id === userId,
            created_at: conversation.created_at,
            updated_at: conversation.updated_at,
            message_count: messages.length,
            messages,
        };
    }

    @Post(':campaignId/ask/conversations')
    @UseGuards(CampaignWriteGuard)
    @ApiOkResponse({ type: AskConversationDto })
    @ApiForbiddenResponse({ description: 'You must be part of this campaign to talk to the Bard.' })
    create(@Req() request: AuthenticatedRequest): AskConversationDto {
        assertMutationOrigin(request);
        return this.ask.create(request.campaignId!, request.webSession.discordUserId);
    }

    /**
     * A question to the Bardo: the only costly action in this controller.
     *
     * The cost has already been shown by `estimate`; here we reserve, invoke
     * and capture or release, exactly as `$ask` does on Discord.
     */
    @Post(':campaignId/ask/conversations/:conversationId/messages')
    @UseGuards(CampaignWriteGuard)
    @ApiOkResponse({ type: AskAnswerDto })
    @ApiBadRequestResponse({ description: 'Empty or oversized question.' })
    @ApiForbiddenResponse({ description: 'Only the author can ask in this conversation.' })
    @ApiConflictResponse({ description: 'The Bard is still answering in this conversation.' })
    @ApiNotFoundResponse({ description: 'No such conversation in this campaign.' })
    askQuestion(
        @Req() request: AuthenticatedRequest,
        @Param('conversationId') rawId: string,
        @Body() body: AskQuestionBodyDto,
    ): Promise<AskAnswerDto> {
        assertMutationOrigin(request);
        const userId = request.webSession.discordUserId;
        const question = parseQuestion(body);
        // Writing requires ownership: sharing publishes read-only, and it must not
        // cause spend on the provider account of whoever opened the thread.
        const conversation = this.ask.owned(request.campaignId!, userId, parseConversationId(rawId));
        return this.ask.ask(request.campaignId!, userId, conversation, question);
    }

    @Patch(':campaignId/ask/conversations/:conversationId')
    @UseGuards(CampaignWriteGuard)
    @HttpCode(204)
    @ApiOkResponse({ description: 'Conversation renamed and/or shared.' })
    @ApiBadRequestResponse({ description: 'Empty or oversized title.' })
    @ApiForbiddenResponse({ description: 'Only the author can change this conversation.' })
    update(
        @Req() request: AuthenticatedRequest,
        @Param('conversationId') rawId: string,
        @Body() body: AskConversationPatchDto,
    ): void {
        assertMutationOrigin(request);
        const conversation = this.ask.owned(
            request.campaignId!, request.webSession.discordUserId, parseConversationId(rawId),
        );

        if (body?.title !== undefined) {
            const title = String(body.title).trim();
            if (title.length === 0) throw new BadRequestException('title must not be empty');
            if (title.length > ASK_TITLE_MAX_CHARS) {
                throw new BadRequestException(`title must be at most ${ASK_TITLE_MAX_CHARS} characters`);
            }
            this.ask.rename(conversation.id, title);
        }

        if (body?.shared !== undefined) {
            if (typeof body.shared !== 'boolean') throw new BadRequestException('shared must be a boolean');
            this.ask.setShared(conversation.id, body.shared);
        }
    }

    @Delete(':campaignId/ask/conversations/:conversationId')
    @UseGuards(CampaignWriteGuard)
    @HttpCode(204)
    @ApiForbiddenResponse({ description: 'Only the author can delete this conversation.' })
    @ApiNotFoundResponse({ description: 'No such conversation in this campaign.' })
    remove(
        @Req() request: AuthenticatedRequest,
        @Param('conversationId') rawId: string,
    ): void {
        assertMutationOrigin(request);
        const conversation = this.ask.owned(
            request.campaignId!,
            request.webSession.discordUserId,
            parseConversationId(rawId),
            request.guildAccess?.canManage ?? false,
        );
        this.ask.remove(conversation.id);
    }
}
