import { useAppInfo } from '../api/hooks';
import { useT } from '../i18n';
import { BrandIcon } from './icons';
import type { DonationPlatform } from '../api/types';

const PLATFORM_LABEL: Record<DonationPlatform, string> = {
    kofi: 'Ko-fi',
    github: 'GitHub Sponsors',
};

/** Prominent donation destinations for visitors who are not signed in yet. */
export function LoginDonationButtons() {
    const t = useT();
    const { data } = useAppInfo();
    const activeChannels = (data?.donations ?? []).filter(channel => channel.active);

    if (activeChannels.length === 0) return null;

    return (
        <aside className="login-support" aria-label={t.support.label}>
            <span className="login-support__label">{t.support.label}</span>
            <div className="login-support__buttons">
                {activeChannels.map(channel => {
                    const label = PLATFORM_LABEL[channel.platform];
                    return (
                        <a
                            key={channel.platform}
                            className={`login-support__button login-support__button--${channel.platform}`}
                            href={channel.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={t.support.donateOn(label)}
                        >
                            <BrandIcon name={channel.platform} />
                            {label}
                        </a>
                    );
                })}
            </div>
        </aside>
    );
}
