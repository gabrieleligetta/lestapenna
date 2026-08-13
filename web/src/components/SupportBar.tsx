import { useT } from '../i18n';
import { useAppInfo } from '../api/hooks';
import { BrandIcon, Icon } from './icons';
import type { DonationPlatform } from '../api/types';

/** The mark and the wording belong to the platform, so they are keyed by it. */
const PLATFORM_LABEL: Record<DonationPlatform, string> = {
    kofi: 'Ko-fi',
    github: 'GitHub Sponsors',
};

/**
 * The thin bar at the bottom of every page: what the project is, and the one
 * way to sustain it.
 *
 * Each donation channel has three states, not two. An instance that asks for
 * nothing returns no channel at all and nothing is shown; a channel that is
 * declared but not open yet shows **inert**, because a sponsorship page that
 * has not been published redirects to a plain profile and the reader ends up on
 * something that asks for nothing — worse than never having offered. Only when
 * the money can actually arrive does it become a link.
 *
 * The states are **per channel** rather than shared, and that is the whole
 * reason the payload is a list: Ko-fi accepts money as soon as Stripe clears,
 * while GitHub Sponsors waits weeks on a tax profile. One flag for both would
 * mean either hiding a channel that works or offering one that does not.
 *
 * Each button carries its platform's own mark, because a reader deserves to
 * know which site is about to open before they click it, not after.
 *
 * It renders before `useAppInfo` resolves, with the licence and the tagline it
 * already knows: a bar that pops into existence a moment after the page would
 * shift everything above it.
 */
export function SupportBar() {
    const t = useT();
    const { data } = useAppInfo();

    const donations = data?.donations ?? [];
    const repoUrl = data?.repo_url ?? '';

    return (
        <footer className="support-bar" aria-label={t.support.label}>
            <span className="support-bar__tagline">
                <Icon name="heart" />
                <span className="support-bar__tagline-text">{t.support.tagline}</span>
            </span>

            {donations.map((channel) => {
                const label = PLATFORM_LABEL[channel.platform];
                const className = `support-bar__donate support-bar__donate--${channel.platform}`;

                return channel.active ? (
                    <a
                        key={channel.platform}
                        className={className}
                        href={channel.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        // The mark alone would leave the destination to be guessed
                        // by whoever cannot see it.
                        aria-label={t.support.donateOn(label)}
                    >
                        <BrandIcon name={channel.platform} />
                        {label}
                    </a>
                ) : (
                    <span
                        key={channel.platform}
                        className={`${className} support-bar__donate--pending`}
                        aria-disabled="true"
                        title={t.support.donateInactive}
                    >
                        <BrandIcon name={channel.platform} />
                        {label}
                    </span>
                );
            })}

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
