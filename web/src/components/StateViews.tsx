import { ApiError } from '../api/client';
import { useT } from '../i18n';
import { Icon } from './icons';

export function Loading() {
    const t = useT();
    return (
        <div className="status state-view" role="status" aria-live="polite">
            <Icon name="loading" className="state-view__icon state-view__icon--loading" />
            <p>{t.common.loading}</p>
        </div>
    );
}

export function Empty({ message }: { message?: string }) {
    const t = useT();
    return (
        <div className="status state-view">
            <Icon name="empty" className="state-view__icon" />
            <p>{message ?? t.common.empty}</p>
        </div>
    );
}

/**
 * One error surface for every query.
 *
 * A 403 is not a failure to retry: the session is valid, the campaign just is
 * not yours. Rendering it as "something went wrong" invites the user to reload
 * forever, so it gets its own copy.
 */
export function ErrorState({ error }: { error?: unknown }) {
    const t = useT();

    if (error instanceof ApiError && error.status === 403) {
        return (
            <div className="status status-error state-view" role="alert">
                <Icon name="error" className="state-view__icon" />
                <p>{t.errors.forbidden}</p>
                <p className="status-hint">{t.errors.forbiddenHint}</p>
            </div>
        );
    }

    if (error instanceof ApiError && error.status === 404) {
        return (
            <div className="status status-error state-view" role="alert">
                <Icon name="error" className="state-view__icon" />
                <p>{t.errors.notFound}</p>
            </div>
        );
    }

    return (
        <div className="status status-error state-view" role="alert">
            <Icon name="error" className="state-view__icon" />
            <p>{t.common.error}</p>
        </div>
    );
}
