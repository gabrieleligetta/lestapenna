/**
 * Ownership check for the commands that accept a session id.
 *
 * Several commands take an id from the arguments and use it straight away:
 * `$download` builds a bucket key out of it and returns a signed link valid for
 * 24 hours, `$ingest` re-runs ingestion over it, `$reset` re-transcribes
 * everything. None of them checked that the session belonged to **this server**.
 *
 * The ids are UUIDs, so they cannot be guessed by trying — but they are not
 * secret either: they show up in published recaps, in `$listsessions`, in the
 * logs and in file names. «Hard to guess» is not an authorisation check, and
 * here the check was missing altogether.
 *
 * The character constraint is the other half: the id ends up inside an S3 key
 * (`recordings/<id>/…`), and without a filter a `../` walks it out of the
 * prefix. We accept the alphabet shared by the three formats in use (UUID,
 * `test-direct-…`, `recovered-…`) rather than listing them: a new format
 * tomorrow must not break the command, but must not be able to contain a slash
 * either.
 */

import { CommandContext } from '../types';
import { sessionRepository } from '../../db';
import { errorReply } from './embeds';
import { t } from '../../i18n';

/** Allowed alphabet for a session id: no slashes, dots or spaces. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Checks that `sessionId` is well-formed and belongs to the context's guild.
 *
 * It answers the user itself and returns `false` when it fails: the caller only
 * has to stop.
 */
export async function assertSessionInGuild(ctx: CommandContext, sessionId: string): Promise<boolean> {
    const id = (sessionId || '').trim();

    if (!SAFE_SESSION_ID.test(id)) {
        await errorReply(ctx, t(ctx.locale, 'session.idMalformed', { id: id || '—' }));
        return false;
    }

    const owner = sessionRepository.getSessionGuildId(id);

    // A session that does not exist and a session owned by another server get
    // the same answer on purpose: telling them apart would let whoever tries a
    // random id learn whether that session exists somewhere.
    if (!owner || owner !== ctx.guildId) {
        await errorReply(ctx, t(ctx.locale, 'session.notInThisGuild', { id }));
        return false;
    }

    return true;
}

/**
 * The stricter check for player-facing commands tied to the active campaign.
 * A guild can host separate tables; being able to use one table's command
 * channel must not disclose or rewrite a different campaign's session.
 */
export async function assertSessionInActiveCampaign(ctx: CommandContext, sessionId: string): Promise<boolean> {
    if (!await assertSessionInGuild(ctx, sessionId)) return false;

    const campaignId = ctx.activeCampaign?.id;
    if (!campaignId || !sessionRepository.belongsToCampaign(sessionId, campaignId)) {
        // Reuse the non-enumerating answer: callers must not learn that an id
        // exists merely because it belongs to another campaign.
        await errorReply(ctx, t(ctx.locale, 'session.notInThisGuild', { id: sessionId }));
        return false;
    }

    return true;
}
