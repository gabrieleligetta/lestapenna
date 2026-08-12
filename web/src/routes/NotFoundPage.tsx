import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { Icon } from '../components/icons';

/**
 * Catch-all so an unknown URL renders a page instead of an empty shell and a
 * console warning.
 *
 * It carries an `<h1>` like every other page: `AppShell` derives `document.title`
 * from the first heading inside `<main>`, so a page without one leaves the tab
 * showing whatever was there before.
 */
export function NotFoundPage() {
    const t = useT();
    return (
        <div className="status status-error state-view" role="alert">
            <Icon name="error" className="state-view__icon" />
            <h1>{t.errors.notFound}</h1>
            <Link to="/guilds">{t.nav.servers}</Link>
        </div>
    );
}
