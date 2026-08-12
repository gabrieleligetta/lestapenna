import { useT } from '../i18n';
import { useAppInfo } from '../api/hooks';
import { Icon } from './icons';

/**
 * The thin bar at the bottom of every page: what the project is, and the one
 * way to sustain it.
 *
 * The donation item has three states, not two. An instance that asks for
 * nothing (`url` empty) does not show it at all; an instance whose channel is
 * declared but not open yet shows it **inert**, because a sponsorship page that
 * has not been published redirects to a plain profile and the reader ends up on
 * something that asks for nothing — worse than never having offered. Only when
 * the money can actually arrive does it become a link.
 *
 * It renders before `useAppInfo` resolves, with the licence and the tagline it
 * already knows: a bar that pops into existence a moment after the page would
 * shift everything above it.
 */
export function SupportBar() {
    const t = useT();
    const { data } = useAppInfo();

    const donationUrl = data?.donation.url ?? '';
    const donationActive = data?.donation.active ?? false;
    const repoUrl = data?.repo_url ?? '';

    return (
        <footer className="support-bar" aria-label={t.support.label}>
            <span className="support-bar__tagline">
                <Icon name="heart" />
                <span className="support-bar__tagline-text">{t.support.tagline}</span>
            </span>

            {donationUrl && (donationActive ? (
                <a href={donationUrl} target="_blank" rel="noopener noreferrer">
                    {t.support.donate}
                </a>
            ) : (
                <span
                    className="support-bar__pending"
                    aria-disabled="true"
                    title={t.support.donateInactive}
                >
                    {t.support.donate}
                </span>
            ))}

            {repoUrl && (
                <a href={repoUrl} target="_blank" rel="noopener noreferrer">
                    {t.support.source}
                </a>
            )}

            <a className="support-bar__license" href="/license">
                {t.support.license}
            </a>
        </footer>
    );
}
