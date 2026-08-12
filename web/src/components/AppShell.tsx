import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { logout } from '../api/client';
import { useLocale, useT, LOCALES, persistLocale, type Locale } from '../i18n';
import { clearReturnPath } from '../returnPath';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { MEDIA } from '../breakpoints';
import { Sidebar } from './Sidebar';
import { Breadcrumbs } from './Breadcrumbs';
import { CampaignSwitcher } from './CampaignSwitcher';
import { ThemeToggle } from './ThemeToggle';
import { ReportButton } from './ReportButton';
import { ReportDialog } from './ReportDialog';
import { AiJobBell } from './AiJobBell';
import { AiJobDock } from './AiJobDock';
import { SupportBar } from './SupportBar';
import { useAnyModalOpen } from './modalStack';
import { Icon } from './icons';

export function AppShell() {
    const queryClient = useQueryClient();
    const { locale, setLocale } = useLocale();
    const t = useT();
    const isDesktop = useMediaQuery(MEDIA.lg);
    const modalOpen = useAnyModalOpen();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [reportOpen, setReportOpen] = useState(false);
    const toggleRef = useRef<HTMLButtonElement>(null);
    const mainRef = useRef<HTMLElement>(null);
    const previousPath = useRef<string | null>(null);
    const { pathname } = useLocation();

    // Reaching the shell means the post-login redirect has been honoured; keeping
    // the stored path around would hijack the next login in this tab.
    useEffect(() => {
        clearReturnPath();
    }, []);

    // Navigating from inside the drawer must dismiss it, or the new page opens
    // underneath a panel that is still covering it.
    useEffect(() => {
        setDrawerOpen(false);
        if (previousPath.current !== null && previousPath.current !== pathname) {
            window.requestAnimationFrame(() => mainRef.current?.focus());
        }
        previousPath.current = pathname;
    }, [pathname]);

    useEffect(() => {
        document.documentElement.lang = locale;
        const updateTitle = () => {
            const heading = mainRef.current?.querySelector('h1')?.textContent?.trim();
            document.title = heading ? `${heading} · Lestapenna` : 'Lestapenna';
        };
        updateTitle();
        const observer = new MutationObserver(updateTitle);
        if (mainRef.current) {
            observer.observe(mainRef.current, {
                childList: true,
                subtree: true,
                characterData: true,
            });
        }
        return () => observer.disconnect();
    }, [locale, pathname]);

    async function handleLogout() {
        await logout();
        queryClient.clear();
        window.location.href = '/';
    }

    function dismissDrawer() {
        setDrawerOpen(false);
        window.requestAnimationFrame(() => toggleRef.current?.focus());
    }

    const backgroundInert = drawerOpen && !isDesktop;
    // Every `Modal` portals out of the shell and registers itself, so any open
    // dialog — not just the report one that used to be wired here by hand —
    // takes the shell out of the tab and screen-reader tree.
    const shellInert = modalOpen || backgroundInert;

    return (
        <>
        <div className="app-shell" inert={shellInert || undefined}>
            <a className="skip-link" href="#main-content">
                {t.nav.skipToContent}
            </a>
            <header className="app-header">
                <button
                    ref={toggleRef}
                    type="button"
                    className="icon-button nav-toggle"
                    aria-expanded={drawerOpen}
                    aria-controls="app-sidebar"
                    aria-label={drawerOpen ? t.nav.close : t.nav.menu}
                    onClick={() => setDrawerOpen((open) => !open)}
                >
                    <Icon name={drawerOpen ? 'close' : 'menu'} />
                </button>

                <Link to="/guilds" className="brand" inert={backgroundInert}>
                    <img
                        className="brand-mark"
                        src={`${import.meta.env.BASE_URL}assets/mark.svg`}
                        alt=""
                        width="32"
                        height="32"
                    />
                    <span>Lestapenna</span>
                </Link>

                <div className="campaign-switcher-slot" inert={backgroundInert}>
                    <CampaignSwitcher />
                </div>

                <div className="app-header-actions" inert={backgroundInert}>
                    <AiJobBell />
                    <ReportButton onClick={() => setReportOpen(true)} />
                    <ThemeToggle />
                    <label className="visually-hidden" htmlFor="locale-select">
                        {t.nav.language}
                    </label>
                    <select
                        id="locale-select"
                        value={locale}
                        onChange={(e) => {
                            const next = e.target.value as Locale;
                            setLocale(next);
                            persistLocale(next);
                        }}
                    >
                        {Object.keys(LOCALES).map((l) => (
                            <option key={l} value={l}>
                                {l}
                            </option>
                        ))}
                    </select>
                    <button type="button" onClick={handleLogout}>
                        {t.common.logout}
                    </button>
                </div>
            </header>

            <div className="app-body">
                <Sidebar
                    open={drawerOpen}
                    isDesktop={isDesktop}
                    onClose={() => setDrawerOpen(false)}
                    onDismiss={dismissDrawer}
                    onLogout={() => void handleLogout()}
                />
                {drawerOpen && !isDesktop && (
                    <div
                        className="scrim"
                        onClick={dismissDrawer}
                        aria-hidden="true"
                    />
                )}
                <main
                    ref={mainRef}
                    id="main-content"
                    className="app-main"
                    tabIndex={-1}
                    inert={backgroundInert}
                >
                    <Breadcrumbs />
                    <Outlet />
                </main>
            </div>

            {/* Inside the shell, so an open dialog takes it out of the tab and
                screen-reader tree along with everything else. */}
            <SupportBar />
        </div>
        <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} />
        {/* Outside the shell, and therefore outside every dialog and every
            route: work that outlives the panel that asked for it needs a place
            to report from that outlives it too. */}
        <AiJobDock />
        </>
    );
}
