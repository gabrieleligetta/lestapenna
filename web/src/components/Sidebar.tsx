import { NavLink, useParams } from 'react-router-dom';
import { useCampaignOverview, useCampaignPermissions } from '../api/hooks';
import { useT } from '../i18n';
import type { EntityType } from '../api/types';
import { useDialogBehaviour } from './useDialogBehaviour';
import { Icon, type IconName } from './icons';

type EntityNavItem = EntityType & IconName;

// Keep the world comprehensible at a glance. Ten equal-weight links made the
// sidebar feel like a database schema; these groups follow the player's mental
// model while preserving every route.
const ENTITY_NAV_GROUPS: Array<{
    label: 'world' | 'treasures';
    items: EntityNavItem[];
}> = [
    { label: 'world', items: ['locations', 'bestiary'] },
    { label: 'treasures', items: ['inventory', 'artifacts'] },
];

const ADVENTURE_NAV: EntityNavItem[] = ['sessions', 'quests', 'timeline'];
const COMPANY_NAV: EntityNavItem[] = ['characters', 'npcs', 'factions'];

interface Props {
    /** Drawer state; ignored above the `lg` breakpoint, where the sidebar is a column. */
    open: boolean;
    isDesktop: boolean;
    onClose: () => void;
    onDismiss: () => void;
    onLogout: () => void;
}

export function Sidebar({ open, isDesktop, onClose, onDismiss, onLogout }: Props) {
    const { guildId = '', campaignId = '' } = useParams();
    const t = useT();
    // Below `lg` the sidebar is a dialog, and gets the dialog contract: Escape
    // closes, Tab stays inside, focus goes back to the toggle. Above it, it is a
    // column of the page and none of that applies.
    const navRef = useDialogBehaviour<HTMLElement>(!isDesktop && open, onDismiss);

    // Same query key as CampaignLayout, so this is a cache read and not a second
    // request — the counts come along for free.
    const { data: overview } = useCampaignOverview(campaignId);
    // Same query as the overview: the Settings entry only appears to those who
    // can actually use it, instead of leading to a page of nothing but 403s.
    const { canManageMembers } = useCampaignPermissions(campaignId);

    const collapsed = !isDesktop && !open;

    const base = `/guilds/${guildId}/campaigns/${campaignId}`;

    /** Counts the overview already carries; the rest render without a number rather than guessing. */
    const counts: Partial<Record<EntityType, number>> = overview
        ? {
              characters: overview.party.length,
              npcs: overview.counts.npcs,
              locations: overview.counts.locations,
              factions: overview.counts.factions,
              quests: overview.counts.openQuests,
              inventory: overview.counts.inventory,
              artifacts: overview.counts.artifacts,
              bestiary: overview.counts.bestiary,
              sessions: overview.counts.sessions,
          }
        : {};

    return (
        <aside
            ref={navRef}
            id="app-sidebar"
            className={`app-sidebar${open ? ' is-open' : ''}`}
            role={isDesktop ? 'complementary' : 'dialog'}
            aria-modal={!isDesktop && open ? true : undefined}
            aria-label={t.nav.sections.campaign}
            // Keeps the closed drawer out of the tab order and off screen readers.
            // Without it the links are merely translated off-screen and still focusable.
            inert={collapsed}
        >
            {!isDesktop && (
                <button
                    type="button"
                    className="icon-button sidebar-close"
                    data-drawer-close
                    aria-label={t.nav.close}
                    onClick={onDismiss}
                >
                    <Icon name="close" />
                </button>
            )}
            <nav aria-label={t.nav.sections.campaign}>
            <ul className="sidebar-list">
                <li>
                    <NavLink to="/guilds" className="sidebar-link" onClick={onClose}>
                        <Icon name="servers" />
                        <span className="sidebar-label">{t.nav.servers}</span>
                    </NavLink>
                </li>
            </ul>

            {campaignId ? (
                <>
                    <p className="sidebar-heading">{t.nav.sections.adventure}</p>
                    <ul className="sidebar-list">
                        <li>
                            <NavLink to={base} end className="sidebar-link" onClick={onClose}>
                                <Icon name="overview" />
                                <span className="sidebar-label">{t.nav.overview}</span>
                            </NavLink>
                        </li>
                        <li>
                            <NavLink to={`${base}/bard`} className="sidebar-link" onClick={onClose}>
                                <Icon name="sparkles" />
                                <span className="sidebar-label">{t.bard.navLabel}</span>
                            </NavLink>
                        </li>
                        {canManageMembers && (
                            <li>
                                <NavLink to={`${base}/settings`} className="sidebar-link" onClick={onClose}>
                                    <Icon name="edit" />
                                    <span className="sidebar-label">{t.campaignAdmin.settingsNav}</span>
                                </NavLink>
                            </li>
                        )}
                        {ADVENTURE_NAV.map((entityType) => (
                            <li key={entityType}>
                                <NavLink to={`${base}/${entityType}`} className="sidebar-link" onClick={onClose}>
                                    <Icon name={entityType} />
                                    <span className="sidebar-label">{t.entities[entityType]}</span>
                                    {counts[entityType] !== undefined && (
                                        <span className="sidebar-count">{counts[entityType]}</span>
                                    )}
                                </NavLink>
                            </li>
                        ))}
                    </ul>

                    <p className="sidebar-heading">{t.nav.sections.company}</p>
                    <ul className="sidebar-list">
                        <li>
                            <NavLink to={`${base}/party`} className="sidebar-link" onClick={onClose}>
                                <Icon name="party" />
                                <span className="sidebar-label">{t.overview.party}</span>
                            </NavLink>
                        </li>
                        {COMPANY_NAV.map((entityType) => (
                            <li key={entityType}>
                                <NavLink to={`${base}/${entityType}`} className="sidebar-link" onClick={onClose}>
                                    <Icon name={entityType} />
                                    <span className="sidebar-label">{t.entities[entityType]}</span>
                                    {counts[entityType] !== undefined && (
                                        <span className="sidebar-count">{counts[entityType]}</span>
                                    )}
                                </NavLink>
                            </li>
                        ))}
                    </ul>

                    {ENTITY_NAV_GROUPS.map((group) => (
                        <div className="sidebar-group" key={group.label}>
                            <p className="sidebar-heading">{t.nav.sections[group.label]}</p>
                            <ul className="sidebar-list">
                                {group.items.map((entityType) => (
                                    <li key={entityType}>
                                        <NavLink to={`${base}/${entityType}`} className="sidebar-link" onClick={onClose}>
                                            <Icon name={entityType} />
                                            <span className="sidebar-label">{t.entities[entityType]}</span>
                                            {counts[entityType] !== undefined && (
                                                <span className="sidebar-count">{counts[entityType]}</span>
                                            )}
                                        </NavLink>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </>
            ) : null}

            {!isDesktop && (
                <div className="sidebar-mobile-actions">
                    <button type="button" className="sidebar-link" onClick={onLogout}>
                        <Icon name="logout" />
                        <span className="sidebar-label">{t.common.logout}</span>
                    </button>
                </div>
            )}
            </nav>
        </aside>
    );
}
