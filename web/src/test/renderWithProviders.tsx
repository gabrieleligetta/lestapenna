import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LocaleContext, type Locale } from '../i18n';
import { ThemeProvider } from '../context/ThemeProvider';

interface Options {
    /** Initial URL. Use with `path` when the component reads route params. */
    route?: string;
    /** Route pattern to mount `ui` under, e.g. '/guilds/:guildId/campaigns/:campaignId/:entityType'. */
    path?: string;
    locale?: Locale;
}

/**
 * Wraps a component in the same providers main.tsx gives it.
 *
 * Retries are disabled: with the default `retry: 1` every error-path assertion
 * would wait out a retry before the failed state is observable.
 */
export function renderWithProviders(ui: ReactElement, { route = '/', path, locale = 'en' }: Options = {}) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    function Wrapper({ children }: { children: ReactNode }) {
        return (
            <Providers queryClient={queryClient} locale={locale} route={route}>
                {path ? (
                    <Routes>
                        <Route path={path} element={children} />
                    </Routes>
                ) : (
                    children
                )}
            </Providers>
        );
    }

    return { queryClient, ...render(ui, { wrapper: Wrapper }) };
}

/**
 * For layout routes, which only exist in relation to their children: pass the
 * <Route> tree itself instead of a single element.
 */
export function renderRoutes(routes: ReactNode, { route = '/', locale = 'en' }: Omit<Options, 'path'> = {}) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    return {
        queryClient,
        ...render(
            <Providers queryClient={queryClient} locale={locale} route={route}>
                <Routes>{routes}</Routes>
            </Providers>,
        ),
    };
}

function Providers({
    queryClient,
    locale,
    route,
    children,
}: {
    queryClient: QueryClient;
    locale: Locale;
    route: string;
    children: ReactNode;
}) {
    return (
        <LocaleContext.Provider value={{ locale, setLocale: () => {} }}>
            <ThemeProvider>
                <QueryClientProvider client={queryClient}>
                    <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
                </QueryClientProvider>
            </ThemeProvider>
        </LocaleContext.Provider>
    );
}
