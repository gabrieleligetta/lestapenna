import {
    BadGatewayException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { askBard } from '../../../bard';
import { phaseConfigFor } from '../../../bard/config';
import { scopeForCampaign } from '../../../bard/ai/scope';
import {
    askConversationRepository,
    type AskConversation,
    type AskConversationSummary,
    type AskMessage,
} from '../../../db/repositories/AskConversationRepository';
import type { AskAnswerDto, AskConversationDto, AskEstimateDto, AskMessageDto } from './ask.dto';

export const ASK_QUESTION_MAX_CHARS = 2000;
export const ASK_TITLE_MAX_CHARS = 120;
/** Same history budget as the `$ask` Discord command: 6 messages, 3 exchanges. */
export const ASK_HISTORY_TURNS = 6;

/**
 * One exchange at a time per conversation.
 *
 * A double click on the "Ask" button would produce two calls to the model —
 * therefore two real charges on the user's provider account. It is the cheapest
 * protection there is against double spend.
 */
const exchangesInFlight = new Set<number>();

@Injectable()
export class AskService {
    /**
     * Estimate for the exchange: no call to the model.
     *
     * Feeds the always-visible cost line above the composer. Under BYOK it
     * declares which provider and model *of the user's* the spend will go to,
     * not a list price of ours: the real monetary estimate comes from the cost
     * transparency layer.
     */
    async estimate(campaignId: number, _userId: string): Promise<AskEstimateDto> {
        // Provider and model only: an estimate must not build a client nor touch
        // the credentials. Asking for them here would mean that a table with no
        // keys could not even *find out* what configuring them would cost it.
        const phase = phaseConfigFor('chat', scopeForCampaign(campaignId));
        return {
            provider: phase.provider,
            model: phase.model,
        };
    }

    listConversations(campaignId: number, userId: string, limit: number, offset: number) {
        const rows = askConversationRepository.listVisible(campaignId, userId, limit, offset);
        return {
            items: rows.map((row) => toConversationDto(row, userId)),
            total: askConversationRepository.countVisible(campaignId, userId),
        };
    }

    create(campaignId: number, userId: string): AskConversationDto {
        return toConversationDto(askConversationRepository.create(campaignId, userId), userId, 0);
    }

    /** Reading: one's own conversation, or one a member has shared. */
    readable(campaignId: number, userId: string, conversationId: number): AskConversation {
        const conversation = this.require(campaignId, conversationId);
        if (conversation.user_id !== userId && conversation.shared !== 1) {
            throw new ForbiddenException('This conversation is private');
        }
        return conversation;
    }

    /**
     * Writing: the owner only.
     *
     * Sharing publishes read-only. Letting others write too would interleave two
     * conversational histories in the same context, and would cause spend on the
     * provider account of whoever opened the thread.
     */
    owned(campaignId: number, userId: string, conversationId: number, guildCanManage = false): AskConversation {
        const conversation = this.require(campaignId, conversationId);
        if (conversation.user_id !== userId && !guildCanManage) {
            throw new ForbiddenException('Only the author can change this conversation');
        }
        return conversation;
    }

    messages(conversationId: number): AskMessageDto[] {
        return askConversationRepository.getMessages(conversationId).map(toMessageDto);
    }

    rename(conversationId: number, title: string): void {
        askConversationRepository.rename(conversationId, title);
    }

    setShared(conversationId: number, shared: boolean): void {
        askConversationRepository.setShared(conversationId, shared);
    }

    remove(conversationId: number): void {
        askConversationRepository.remove(conversationId);
    }

    /**
     * One exchange with the Bardo.
     *
     * `askBard` already records the usage itself in `ai_usage_log` and on
     * `usage_tracking`: it must not be duplicated here.
     */
    async ask(
        campaignId: number,
        userId: string,
        conversation: AskConversation,
        question: string,
    ): Promise<AskAnswerDto> {
        if (exchangesInFlight.has(conversation.id)) {
            throw new ConflictException('The Bard is still answering in this conversation');
        }
        exchangesInFlight.add(conversation.id);
        try {
            const history = askConversationRepository.getRecentTurns(conversation.id, ASK_HISTORY_TURNS);
            // This only labels the stored message: the real call, credentials
            // included, is made by `askBard`.
            const phase = phaseConfigFor('chat', scopeForCampaign(campaignId));

            let result;
            try {
                result = await askBard(campaignId, question, history);
            } catch (error) {
                console.error('[AskWeb] askBard failed:', error);
                throw new BadGatewayException('The Bard could not be reached');
            }

            // `succeeded: false` means the answer is only a fallback text: we do
            // not pollute the conversation with a non-answer.
            if (!result.succeeded) {
                throw new BadGatewayException('The Bard could not answer right now');
            }

            const message = askConversationRepository.appendExchange({
                conversationId: conversation.id,
                question,
                answer: result.answer,
                costUsd: result.costUsd,
                costEur: result.costEur,
                provider: phase.provider,
                model: phase.model,
            });

            const updated = askConversationRepository.get(conversation.id)!;
            return {
                conversation: toConversationDto(updated, userId, askConversationRepository.countMessages(conversation.id)),
                message: toMessageDto(message),
                grounded: result.grounded,
                missing: result.missing,
            };
        } finally {
            exchangesInFlight.delete(conversation.id);
        }
    }

    private require(campaignId: number, conversationId: number): AskConversation {
        const conversation = askConversationRepository.get(conversationId);
        if (!conversation || conversation.campaign_id !== campaignId) {
            throw new NotFoundException('No such conversation in this campaign');
        }
        return conversation;
    }
}

function toConversationDto(
    row: AskConversation | AskConversationSummary,
    viewerUserId: string,
    messageCount?: number,
): AskConversationDto {
    return {
        id: row.id,
        title: row.title,
        shared: row.shared === 1,
        owned: row.user_id === viewerUserId,
        created_at: row.created_at,
        updated_at: row.updated_at,
        message_count: messageCount ?? (row as AskConversationSummary).message_count ?? 0,
    };
}

function toMessageDto(row: AskMessage): AskMessageDto {
    return {
        id: row.id,
        role: row.role,
        content: row.content,
        created_at: row.created_at,
        cost_usd: row.cost_usd,
        cost_eur: row.cost_eur,
        provider: row.provider,
        model: row.model,
    };
}
