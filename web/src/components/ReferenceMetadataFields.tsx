import { REFERENCE_ROLES, type ReferenceRole } from '../api/types';
import { useT } from '../i18n';

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

    function toggle(role: ReferenceRole, checked: boolean) {
        if (checked && role === 'whole_image') {
            onRolesChange(['whole_image']);
            return;
        }
        let next = roles.filter((current) => current !== 'whole_image' && current !== role);
        if (checked) next = [...next, role];
        // A reference with no contract is ambiguous. Keep the last tag selected
        // so the paid request cannot reach the backend in that state.
        if (next.length === 0) return;
        onRolesChange(REFERENCE_ROLES.filter((candidate) => next.includes(candidate)));
    }

    return (
        <div className="reference-metadata">
            <fieldset className="reference-metadata__roles">
                <legend>{t.references.tags}</legend>
                <p className="settings-hint">{t.references.tagsHint}</p>
                <div className="reference-metadata__role-grid">
                    {REFERENCE_ROLES.map((role) => (
                        <label key={role} className="settings-form__check">
                            <input
                                type="checkbox"
                                checked={roles.includes(role)}
                                disabled={disabled}
                                onChange={(event) => toggle(role, event.currentTarget.checked)}
                            />
                            <span>{t.references.roleNames[role]}</span>
                        </label>
                    ))}
                </div>
            </fieldset>
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
                <label className="settings-form__check">
                    <input
                        type="checkbox"
                        checked={autoSelect ?? false}
                        disabled={disabled}
                        onChange={(event) => onAutoSelectChange?.(event.currentTarget.checked)}
                    />
                    <span>{t.references.autoSelect}</span>
                </label>
            )}
        </div>
    );
}
