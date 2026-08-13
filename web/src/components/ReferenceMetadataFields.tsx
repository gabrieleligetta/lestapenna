import { REFERENCE_ROLES, type ReferenceRole } from '../api/types';
import { useT } from '../i18n';
import { Icon } from './icons';

/** Provider-neutral controls shared by saved references and per-job overrides. */
export function ReferenceMetadataFields({
    roles,
    instruction,
    autoSelect,
    disabled = false,
    showAutoSelect = false,
    onRolesChange,
    onInstructionChange,
    onAutoSelectChange,
}: {
    roles: ReferenceRole[];
    instruction: string;
    autoSelect?: boolean;
    disabled?: boolean;
    showAutoSelect?: boolean;
    onRolesChange: (roles: ReferenceRole[]) => void;
    onInstructionChange: (instruction: string) => void;
    onAutoSelectChange?: (autoSelect: boolean) => void;
}) {
    const t = useT();

    function add(role: ReferenceRole) {
        if (role === 'whole_image') {
            onRolesChange(['whole_image']);
            return;
        }
        const next = [...roles.filter((current) => current !== 'whole_image' && current !== role), role];
        onRolesChange(REFERENCE_ROLES.filter((candidate) => next.includes(candidate)));
    }

    function remove(role: ReferenceRole) {
        // A reference with no contract is ambiguous. Keep the last tag selected
        // so the paid request cannot reach the backend in that state.
        if (roles.length === 1) return;
        const next = roles.filter((current) => current !== role);
        onRolesChange(REFERENCE_ROLES.filter((candidate) => next.includes(candidate)));
    }

    const available = REFERENCE_ROLES.filter((role) => !roles.includes(role));

    return (
        <div className="reference-metadata">
            <div className="reference-metadata__roles">
                <span className="reference-metadata__label">{t.references.tags}</span>
                <p className="settings-hint">{t.references.tagsHint}</p>
                <div className="reference-metadata__tag-picker">
                    <div className="reference-metadata__tags" aria-label={t.references.tags}>
                        {roles.map((role) => (
                            <span key={role} className="reference-metadata__tag" data-role={role}>
                                <span>{t.references.roleNames[role]}</span>
                                {roles.length > 1 && (
                                    <button
                                        type="button"
                                        disabled={disabled}
                                        aria-label={`${t.references.remove} ${t.references.roleNames[role]}`}
                                        onClick={() => remove(role)}
                                    >
                                        <Icon name="close" />
                                    </button>
                                )}
                            </span>
                        ))}
                    </div>
                    <label className="reference-metadata__add-tag">
                        <span className="visually-hidden">{t.references.addTag}</span>
                        <select
                            value=""
                            disabled={disabled || available.length === 0}
                            aria-label={t.references.addTag}
                            onChange={(event) => {
                                const role = event.currentTarget.value as ReferenceRole;
                                if (role) add(role);
                            }}
                        >
                            <option value="">＋ {t.references.addTag}</option>
                            {available.map((role) => (
                                <option key={role} value={role}>{t.references.roleNames[role]}</option>
                            ))}
                        </select>
                    </label>
                </div>
            </div>
            <label>
                <span>{t.references.instruction}</span>
                <textarea
                    rows={2}
                    maxLength={300}
                    value={instruction}
                    disabled={disabled}
                    placeholder={t.references.instructionPlaceholder}
                    onChange={(event) => onInstructionChange(event.currentTarget.value)}
                />
            </label>
            {showAutoSelect && (
                <button
                    type="button"
                    role="switch"
                    aria-checked={autoSelect ?? false}
                    className="reference-metadata__auto-select"
                    disabled={disabled}
                    onClick={() => onAutoSelectChange?.(!(autoSelect ?? false))}
                >
                    <span className="reference-metadata__switch-track" aria-hidden="true">
                        <span />
                    </span>
                    <span>{t.references.autoSelect}</span>
                </button>
            )}
        </div>
    );
}
