import { ReferenceImagesPanel } from '../components/ReferenceImagesPanel';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
    useCampaignAdminActions,
    useCampaignAiSettings,
    useCampaignMembers,
    useCampaignPermissions,
    useCampaignSettings,
} from '../api/hooks';
import { EffectiveTable } from './GuildAiSettingsPage';
import { CampaignAiAdvanced } from './CampaignAiAdvanced';
import { CampaignTranscription } from './CampaignTranscription';
import { CampaignSummaryFlow } from './CampaignSummaryFlow';
import { CampaignEmbedding } from './CampaignEmbedding';
import type { CampaignMember } from '../api/types';
import { LOCALES, useT, type Locale } from '../i18n';
import { ConfirmModal } from '../components/ConfirmModal';
import { Empty, ErrorState, Loading } from '../components/StateViews';
import { FormFeedback } from '../components/FormFeedback';

const LANGUAGE_NAMES: Record<Locale, string> = {
    en: 'English',
    it: 'Italiano',
    es: 'Español',
    fr: 'Français',
    de: 'Deutsch',
    'pt-BR': 'Português (Brasil)',
};

/**
 * The table's configuration: the web counterpart of `$setworld`, `$language` and
 * `$membri`.
 *
 * Reserved for masters: this is not where game data is corrected, it is where
 * you decide who sits at the table and which world is played in.
 */
export function CampaignSettingsPage() {
    const { campaignId = '' } = useParams();
    const t = useT();
    const { canManageMembers, isLoading: permissionsLoading } = useCampaignPermissions(campaignId);
    const settings = useCampaignSettings(campaignId);
    const members = useCampaignMembers(campaignId);
    const actions = useCampaignAdminActions(campaignId);
    const ai = useCampaignAiSettings(campaignId);

    const [name, setName] = useState('');
    const [language, setLanguage] = useState('');
    const [year, setYear] = useState('');
    const [partyName, setPartyName] = useState('');
    const [autoUpdate, setAutoUpdate] = useState(false);
    const [artDirection, setArtDirection] = useState('');
    const [saved, setSaved] = useState(false);
    const [pendingRemoval, setPendingRemoval] = useState<CampaignMember | null>(null);

    useEffect(() => {
        if (!settings.data) return;
        setName(settings.data.name);
        setLanguage(settings.data.language ?? '');
        setYear(settings.data.current_year === null ? '' : String(settings.data.current_year));
        setPartyName(settings.data.party_name ?? '');
        setAutoUpdate(settings.data.allow_auto_character_update);
        setArtDirection(settings.data.art_direction ?? '');
    }, [settings.data]);

    if (settings.isLoading || permissionsLoading) return <Loading />;
    if (settings.isError && !settings.data) return <ErrorState error={settings.error} />;

    const readOnly = !canManageMembers;

    async function save(event: React.FormEvent) {
        event.preventDefault();
        setSaved(false);
        const parsedYear = year.trim() === '' ? undefined : Number(year);
        const result = await actions.updateSettings({
            name: name.trim(),
            language: language === '' ? null : language,
            ...(parsedYear !== undefined && Number.isFinite(parsedYear) ? { current_year: parsedYear } : {}),
            party_name: partyName.trim() || undefined,
            allow_auto_character_update: autoUpdate,
            art_direction: artDirection.trim() || null,
        });
        if (result) setSaved(true);
    }

    return (
        <div className="settings-page">
            <h1>{t.campaignAdmin.settingsTitle}</h1>
            {readOnly && <p className="status">{t.campaignAdmin.masterOnly}</p>}

            <form className="settings-form" onSubmit={save}>
                <label>
                    <span>{t.campaignAdmin.name}</span>
                    <input
                        value={name}
                        maxLength={80}
                        required
                        disabled={readOnly || actions.busy}
                        onChange={(event) => setName(event.target.value)}
                    />
                </label>

                <label>
                    <span>{t.campaignAdmin.language}</span>
                    <select
                        value={language}
                        disabled={readOnly || actions.busy}
                        onChange={(event) => setLanguage(event.target.value)}
                    >
                        <option value="">—</option>
                        {(Object.keys(LOCALES) as Locale[]).map((code) => (
                            <option key={code} value={code}>{LANGUAGE_NAMES[code]}</option>
                        ))}
                    </select>
                    <small>{t.campaignAdmin.languageHint}</small>
                </label>

                <label>
                    <span>{t.campaignAdmin.year}</span>
                    <input
                        type="number"
                        value={year}
                        disabled={readOnly || actions.busy}
                        onChange={(event) => setYear(event.target.value)}
                    />
                </label>

                <label>
                    <span>{t.campaignAdmin.partyName}</span>
                    <input
                        value={partyName}
                        maxLength={80}
                        disabled={readOnly || actions.busy}
                        onChange={(event) => setPartyName(event.target.value)}
                    />
                </label>

                <label className="settings-form__check">
                    <input
                        type="checkbox"
                        checked={autoUpdate}
                        disabled={readOnly || actions.busy}
                        onChange={(event) => setAutoUpdate(event.target.checked)}
                    />
                    <span>
                        {t.campaignAdmin.autoCharacterUpdate}
                        <small>{t.campaignAdmin.autoCharacterUpdateHint}</small>
                    </span>
                </label>

                <label>
                    <span>{t.references.artDirection}</span>
                    <textarea
                        value={artDirection}
                        rows={2}
                        maxLength={400}
                        disabled={readOnly || actions.busy}
                        placeholder={t.references.artDirectionPlaceholder}
                        onChange={(event) => setArtDirection(event.target.value)}
                    />
                    <small>{t.references.artDirectionHint}</small>
                </label>

                <FormFeedback error={actions.error} saved={saved} savedLabel={t.campaignAdmin.saved} />

                <div className="modal-actions">
                    <button type="submit" className="primary" disabled={readOnly || actions.busy}>
                        {t.campaignAdmin.save}
                    </button>
                </div>
            </form>

            <section>
                <h2>{t.campaignAdmin.membersTitle}</h2>
                <p className="settings-hint">{t.campaignAdmin.membersIntro}</p>
                {members.isLoading ? (
                    <Loading />
                ) : (members.data ?? []).length === 0 ? (
                    <Empty message={t.campaignAdmin.membersEmpty} />
                ) : (
                    <ul className="members-list">
                        {(members.data ?? []).map((member) => (
                            <li key={member.user_id} className="members-list__row">
                                <span className="members-list__who">
                                    <strong>
                                        {member.display_name
                                            ?? member.character_name
                                            ?? t.campaignAdmin.unknownMember}
                                    </strong>
                                    <small>
                                        {[
                                            member.character_name ?? t.campaignAdmin.noCharacter,
                                            member.username ? `@${member.username}` : member.user_id,
                                        ].join(' · ')}
                                    </small>
                                </span>
                                <span className="members-list__role">
                                    {member.enrolled
                                        ? (member.role === 'MASTER'
                                            ? t.campaignAdmin.roleMaster
                                            : t.campaignAdmin.rolePlayer)
                                        : (
                                            <em title={t.campaignAdmin.notEnrolledHint}>
                                                {t.campaignAdmin.notEnrolled}
                                            </em>
                                        )}
                                </span>
                                {!readOnly && (
                                    <span className="members-list__actions">
                                        {member.enrolled ? (
                                            <>
                                                <button
                                                    type="button"
                                                    disabled={actions.busy}
                                                    onClick={() => actions.setMemberRole(
                                                        member.user_id,
                                                        member.role === 'MASTER' ? 'PLAYER' : 'MASTER',
                                                    )}
                                                >
                                                    {member.role === 'MASTER'
                                                        ? t.campaignAdmin.demote
                                                        : t.campaignAdmin.promote}
                                                </button>
                                                <button
                                                    type="button"
                                                    className="danger-button"
                                                    disabled={actions.busy}
                                                    onClick={() => setPendingRemoval(member)}
                                                >
                                                    {t.campaignAdmin.removeMember}
                                                </button>
                                            </>
                                        ) : (
                                            <button
                                                type="button"
                                                disabled={actions.busy}
                                                onClick={() => actions.setMemberRole(member.user_id, 'PLAYER')}
                                            >
                                                {t.campaignAdmin.enroll}
                                            </button>
                                        )}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <ReferenceImagesPanel campaignId={campaignId} scope="campaign" canEdit={!readOnly} />

            <section className="settings-section">
                <h2>{t.aiSettings.campaignTitle}</h2>
                <p className="settings-hint">{t.aiSettings.campaignIntro}</p>
                {ai.data && (
                    <>
                        <EffectiveTable phases={ai.data.effective} phaseLabel={t.aiSettings.phase} />
                        {/* Masters stay informed about provider and model
                            without gaining access to the keys, which belong to
                            the server. */}
                        {ai.data.can_manage && (
                            <Link to={`/guilds/${ai.data.guild_id}/ai`}>{t.aiSettings.manageLink}</Link>
                        )}
                        <CampaignTranscription
                            campaignId={campaignId}
                            guildId={ai.data.guild_id}
                            readOnly={readOnly}
                        />
                        <CampaignEmbedding campaignId={campaignId} readOnly={readOnly} />
                        <CampaignSummaryFlow
                            campaignId={campaignId}
                            agentic={ai.data.agentic_summary}
                            readOnly={readOnly}
                        />
                        <CampaignAiAdvanced
                            campaignId={campaignId}
                            guildId={ai.data.guild_id}
                            effective={ai.data.effective}
                            overrides={ai.data.overrides}
                            readOnly={readOnly}
                        />
                    </>
                )}
            </section>

            <ConfirmModal
                open={pendingRemoval !== null}
                title={t.campaignAdmin.removeMember}
                question={pendingRemoval
                    ? t.campaignAdmin.removeMemberConfirm(
                        pendingRemoval.display_name
                        ?? pendingRemoval.character_name
                        ?? pendingRemoval.user_id,
                    )
                    : ''}
                busy={actions.busy}
                error={actions.error}
                confirmLabel={t.campaignAdmin.removeMember}
                busyLabel={t.common.loading}
                onClose={() => setPendingRemoval(null)}
                onConfirm={async () => {
                    if (!pendingRemoval) return;
                    await actions.removeMember(pendingRemoval.user_id);
                    setPendingRemoval(null);
                }}
            />
        </div>
    );
}
