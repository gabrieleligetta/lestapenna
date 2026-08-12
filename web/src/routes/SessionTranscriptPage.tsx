import { Link, useParams } from 'react-router-dom';
import { useSessionDetail, useSessionTranscript } from '../api/hooks';
import { ErrorState, Loading } from '../components/StateViews';
import { Icon } from '../components/icons';
import { useLocale, useT } from '../i18n';
import { formatSessionTimestamp } from './sessionPresentation';
import './sessions.css';

export function SessionTranscriptPage() {
    const { guildId = '', campaignId = '', sessionId = '' } = useParams();
    const sessionQuery = useSessionDetail(campaignId, sessionId);
    const transcriptQuery = useSessionTranscript(campaignId, sessionId, true);
    const { locale } = useLocale();
    const t = useT();
    const sessionUrl = `/guilds/${guildId}/campaigns/${campaignId}/sessions/${sessionId}`;

    if (sessionQuery.isLoading || transcriptQuery.isLoading) return <Loading />;
    if (sessionQuery.isError || transcriptQuery.isError) {
        return <ErrorState error={sessionQuery.error ?? transcriptQuery.error} />;
    }

    const session = sessionQuery.data;
    const transcript = transcriptQuery.data;
    if (!session || !transcript) return <ErrorState />;

    const title = session.title ?? t.sessions.untitled;

    return (
        <article className="session-transcript-page" aria-labelledby="session-transcript-title">
            <header className="session-transcript-page__header">
                <p className="sessions-eyebrow">
                    {session.session_number == null
                        ? t.sessions.eyebrow
                        : t.sessions.sessionNumber(session.session_number)}
                </p>
                <h1 id="session-transcript-title">{t.sessions.transcript}</h1>
                <p className="session-transcript-page__session-title">{title}</p>
                <p className="session-transcript-page__subtitle">{t.sessions.transcriptSubtitle}</p>
                <Link className="session-transcript-page__back" to={sessionUrl}>
                    <Icon name="arrowLeft" />
                    {t.sessions.backToSession}
                </Link>
            </header>

            <section className="session-transcript-page__sheet" aria-label={t.sessions.transcript}>
                {transcript.items.length === 0 ? (
                    <p className="session-muted">{t.sessions.transcriptEmpty}</p>
                ) : (
                    <ol className="session-transcript__items">
                        {transcript.items.map((item, index) => {
                            const location = [item.macroLocation, item.microLocation]
                                .filter(Boolean)
                                .join(' · ');

                            return (
                                <li key={`${item.timestamp ?? 'time'}-${item.userId ?? 'speaker'}-${index}`}>
                                    <div className="session-transcript__speaker">
                                        <strong>
                                            {item.characterName ?? item.userId ?? t.sessions.unknownSpeaker}
                                        </strong>
                                        {item.timestamp != null && (
                                            <time>
                                                {formatSessionTimestamp(item.timestamp, locale, true)}
                                            </time>
                                        )}
                                    </div>
                                    <p>{item.text}</p>
                                    {location && (
                                        <span className="session-transcript__location">{location}</span>
                                    )}
                                </li>
                            );
                        })}
                    </ol>
                )}
            </section>
        </article>
    );
}
