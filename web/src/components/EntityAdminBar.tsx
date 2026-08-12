import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEntityMutations } from '../api/hooks';
import type { CrudEntityType, EntityRow } from '../api/types';
import { useT } from '../i18n';
import { ConfirmModal } from './ConfirmModal';
import { EntityEditorModal } from './EntityEditorModal';
import { Icon } from './icons';

/**
 * Edit and delete, for any campaign entity.
 *
 * It sits above the card rather than inside each detail view: the eight views
 * have very different layouts (the artifact has its own hero, the location its
 * panoramic image) and replicating the two buttons in each would mean eight
 * places where the delete confirmation can diverge.
 */
export function EntityAdminBar({
    campaignId,
    entityType,
    entityId,
    entityLabel,
    entityName,
    row,
    /** Where to go back to after deletion: the family's list. */
    listPath,
}: {
    campaignId: string;
    entityType: CrudEntityType;
    entityId: string;
    entityLabel: string;
    entityName: string;
    row: EntityRow | null | undefined;
    listPath: string;
}) {
    const t = useT();
    const navigate = useNavigate();
    const [editing, setEditing] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const { deleteEntity, busy, error, setError } = useEntityMutations(campaignId, entityType);

    async function confirmDelete() {
        const result = await deleteEntity(entityId);
        if (result) navigate(listPath, { replace: true });
    }

    return (
        <div className="entity-admin-bar">
            <button type="button" onClick={() => setEditing(true)}>
                <Icon name="edit" />
                {t.crud.edit}
            </button>
            <button
                type="button"
                className="danger-button"
                onClick={() => {
                    setError(null);
                    setConfirming(true);
                }}
            >
                <Icon name="trash" />
                {t.crud.delete}
            </button>

            <EntityEditorModal
                open={editing}
                onClose={() => setEditing(false)}
                campaignId={campaignId}
                entityType={entityType}
                entityLabel={entityLabel}
                row={row}
            />
            <ConfirmModal
                open={confirming}
                title={t.crud.delete}
                question={t.crud.confirmDelete(entityName)}
                consequences={t.crud.deleteCascade}
                busy={busy}
                error={error}
                confirmLabel={t.crud.delete}
                busyLabel={t.crud.deleting}
                onConfirm={() => void confirmDelete()}
                onClose={() => setConfirming(false)}
            />
        </div>
    );
}
