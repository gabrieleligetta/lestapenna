import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { Icon } from './icons';
import type { ChecklistItem, ChecklistState } from './setupChecklistModel';

const ICONS: Record<ChecklistState, 'check' | 'error' | 'progress'> = {
    done: 'check',
    missing: 'error',
    optional: 'progress',
};

export function SetupChecklist({
    items, guildId, canManage,
}: {
    items: ChecklistItem[];
    guildId: string;
    /** Someone who cannot change the settings gets the state, not the invitation. */
    canManage: boolean;
}) {
    const t = useT();
    const outstanding = items.filter((item) => item.state === 'missing').length;

    return (
        <section className="setup-checklist" aria-label={t.setup.checklistTitle}>
            <h2>{t.setup.checklistTitle}</h2>
            <p className="settings-hint">
                {outstanding === 0 ? t.setup.checklistReady : t.setup.checklistOutstanding(String(outstanding))}
            </p>

            <ul className="setup-checklist__list">
                {items.map((item) => (
                    <li key={item.id} className={`setup-checklist__row is-${item.state}`}>
                        <Icon name={ICONS[item.state]} className="setup-checklist__icon" />
                        <span className="setup-checklist__label">{item.label}</span>
                        <span className="setup-checklist__detail">{item.detail}</span>
                    </li>
                ))}
            </ul>

            {canManage && outstanding > 0 && (
                <p>
                    <Link className="arcane-button" to={`/guilds/${guildId}/setup`}>
                        {t.setup.resume}
                    </Link>
                </p>
            )}
        </section>
    );
}
