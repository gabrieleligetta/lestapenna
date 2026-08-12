import { Fragment } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useCampaignOverview, useGuild, useSessionDetail } from '../api/hooks';
import { useT } from '../i18n';
import type { EntityType } from '../api/types';

interface Crumb {
    label: string;
    to?: string;
}

/**
 * Replaces the per-page "← Back" links, which only ever went up one level and
 * left no way to jump from a detail view straight back to the campaign.
 */
export function Breadcrumbs() {
    const { guildId = '', campaignId = '', entityType = '', entityId = '', sessionId = '' } = useParams();
    const { pathname } = useLocation();
    const t = useT();
    const isTranscript = pathname.endsWith('/transcript');

    // Both are cache reads when the sidebar/layout already asked for them.
    const { data: guild } = useGuild(guildId);
    const { data: overview } = useCampaignOverview(campaignId);
    // The reader requests the same key, so React Query deduplicates this and
    // lets the breadcrumb use a human title instead of exposing an opaque id.
    const { data: session } = useSessionDetail(campaignId, sessionId);

    const crumbs: Crumb[] = [{ label: t.nav.servers, to: '/guilds' }];

    if (guildId) {
        crumbs.push({ label: guild?.name ?? '…', to: `/guilds/${guildId}/campaigns` });
    }
    if (campaignId) {
        crumbs.push({ label: overview?.name ?? '…', to: `/guilds/${guildId}/campaigns/${campaignId}` });
    }
    // `party` is a static route, so it never lands in the :entityType param.
    if (campaignId && pathname.endsWith('/party')) {
        crumbs.push({ label: t.overview.party });
    }
    if (campaignId && pathname.includes('/sessions') && !entityType) {
        crumbs.push({
            label: t.entities.sessions,
            to: sessionId ? `/guilds/${guildId}/campaigns/${campaignId}/sessions` : undefined,
        });
        if (sessionId) {
            crumbs.push({
                label: session?.title ?? sessionId,
                to: isTranscript
                    ? `/guilds/${guildId}/campaigns/${campaignId}/sessions/${sessionId}`
                    : undefined,
            });
        }
        if (isTranscript) crumbs.push({ label: t.sessions.transcript });
    }
    if (entityType) {
        crumbs.push({
            label: entityType in t.entities ? t.entities[entityType as EntityType] : entityType,
            to: entityId ? `/guilds/${guildId}/campaigns/${campaignId}/${entityType}` : undefined,
        });
    }
    if (entityId) {
        crumbs.push({ label: entityId });
    }

    // A single crumb is the page you are already on: nothing to navigate to.
    if (crumbs.length < 2) return null;

    return (
        <nav className="breadcrumbs" aria-label={t.nav.breadcrumbs}>
            <ol>
                {crumbs.map((crumb, i) => {
                    const isLast = i === crumbs.length - 1;
                    return (
                        <Fragment key={`${crumb.label}-${i}`}>
                            <li aria-current={isLast ? 'page' : undefined}>
                                {crumb.to && !isLast ? <Link to={crumb.to}>{crumb.label}</Link> : <span>{crumb.label}</span>}
                            </li>
                            {!isLast && (
                                <li className="breadcrumb-sep" aria-hidden="true">
                                    /
                                </li>
                            )}
                        </Fragment>
                    );
                })}
            </ol>
        </nav>
    );
}
