import { Route, Routes } from 'react-router-dom';
import { LoginPage } from './routes/LoginPage';
import { GuildsPage } from './routes/GuildsPage';
import { CampaignsPage } from './routes/CampaignsPage';
import { CampaignLayout } from './routes/CampaignLayout';
import { CampaignOverviewPage } from './routes/CampaignOverviewPage';
import { PartyPage } from './routes/PartyPage';
import { SessionsArchivePage } from './routes/SessionsArchivePage';
import { SessionReaderPage } from './routes/SessionReaderPage';
import { SessionTranscriptPage } from './routes/SessionTranscriptPage';
import { EntityListPage } from './routes/EntityListPage';
import { EntityDetailPage } from './routes/EntityDetailPage';
import { NotFoundPage } from './routes/NotFoundPage';
import { BardChatPage } from './routes/BardChatPage';
import { CampaignSettingsPage } from './routes/CampaignSettingsPage';
import { GuildAiSettingsPage } from './routes/GuildAiSettingsPage';
import { GuildSetupWizard } from './routes/GuildSetupWizard';
import { GuildPrivacyPage } from './routes/GuildPrivacyPage';
import { RequireAuth } from './routes/RequireAuth';
import { LegalGate } from './routes/LegalGate';
import { AppShell } from './components/AppShell';
import './App.css';

/**
 * Layout routes, not wrapper components: RequireAuth and AppShell each mount
 * once and stay mounted across navigations. Wrapping every page individually
 * (the previous shape) remounted the whole chrome on each route change and
 * forced the campaign overview to be the parent of the lists it links to.
 */
function App() {
    return (
        <Routes>
            <Route path="/" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
                {/* Between authentication and the app: we know who they are, and we ask them to read before letting them in.
                    leggere prima di lasciarlo entrare. */}
                <Route element={<LegalGate />}>
                <Route element={<AppShell />}>
                    <Route path="/guilds" element={<GuildsPage />} />
                    <Route path="/guilds/:guildId/campaigns" element={<CampaignsPage />} />
                    {/* The keys belong to the server, not to the campaign: the route sits under the guild. */}
                    <Route path="/guilds/:guildId/ai" element={<GuildAiSettingsPage />} />
                    {/* The same settings, walked in the order they depend on. A
                        route rather than a modal: it is long, it is resumable,
                        and it has to be linkable from the bot's refusals. */}
                    <Route path="/guilds/:guildId/setup" element={<GuildSetupWizard />} />
                    {/* Your data on this server: a copy, or its erasure. Guild-scoped
                        because that is the scope the erasure actually works on. */}
                    <Route path="/guilds/:guildId/privacy" element={<GuildPrivacyPage />} />
                    <Route path="/guilds/:guildId/campaigns/:campaignId" element={<CampaignLayout />}>
                        <Route index element={<CampaignOverviewPage />} />
                        <Route path="party" element={<PartyPage />} />
                        <Route path="sessions" element={<SessionsArchivePage />} />
                        <Route path="sessions/:sessionId" element={<SessionReaderPage />} />
                        <Route path="sessions/:sessionId/transcript" element={<SessionTranscriptPage />} />
                        <Route path="bard" element={<BardChatPage />} />
                        <Route path="settings" element={<CampaignSettingsPage />} />
                        {/* Declared after the dedicated static routes so they win the match. */}
                        <Route path=":entityType" element={<EntityListPage />} />
                        <Route path=":entityType/:entityId" element={<EntityDetailPage />} />
                    </Route>
                    <Route path="*" element={<NotFoundPage />} />
                </Route>
                </Route>
            </Route>
        </Routes>
    );
}

export default App;
