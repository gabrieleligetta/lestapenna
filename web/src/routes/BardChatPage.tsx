import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
    useAskActions,
    useAskConversation,
    useAskConversations,
    useAskEstimate,
    useCampaignPermissions,
} from '../api/hooks';
import type { AskConversation, AskEstimate, AskMessage } from '../api/types';
import { useLocale, useT } from '../i18n';
import { formatAiMoney } from '../components/aiCostFormatting';
import { ConfirmModal } from '../components/ConfirmModal';
import { Empty, ErrorState, Loading } from '../components/StateViews';
import { Icon } from '../components/icons';
import './bardChat.css';
import { FormFeedback } from '../components/FormFeedback';

/**
 * The chat with the Bardo.
 *
 * The answers are not chat bubbles but full-width prose: the Bardo narrates the
 * campaign, and treating its text as an instant message would make it
 * indistinguishable from any other assistant.
 *
 * The price of the action is always visible above the composer and printed on
 * the send button: the question never leaves without the cost having been shown
 * first (pre-contractual information, `docs/CREDITS-ROLLOUT.md`).
 */
export function BardChatPage() {
    const { campaignId = '' } = useParams();
    const t = useT();
    const { locale } = useLocale();
    const { canWrite } = useCampaignPermissions(campaignId);

    const [activeId, setActiveId] = useState<number | null>(null);
    const [question, setQuestion] = useState('');
    const [renamingId, setRenamingId] = useState<number | null>(null);
    const [renameDraft, setRenameDraft] = useState('');
    const [pendingDelete, setPendingDelete] = useState<AskConversation | null>(null);
    /** The question in flight, shown immediately: waiting for an answer is long. */
    const [inFlight, setInFlight] = useState<string | null>(null);

    const conversations = useAskConversations(campaignId);
    const conversation = useAskConversation(campaignId, activeId);
    const estimate = useAskEstimate(campaignId);
    const actions = useAskActions(campaignId);

    const threadRef = useRef<HTMLDivElement>(null);
    const items = conversations.data?.items ?? [];
    const active = items.find((c) => c.id === activeId) ?? null;
    const messages = conversation.data?.messages ?? [];

    // We land on the most recent conversation rather than on an empty panel
    // that forces an extra click. It depends on the id and not on the array:
    // `items` is recreated on every render and would re-run the effect each time.
    const mostRecentId = items[0]?.id ?? null;
    useEffect(() => {
        if (activeId === null && mostRecentId !== null) setActiveId(mostRecentId);
    }, [activeId, mostRecentId]);

    useEffect(() => {
        const thread = threadRef.current;
        if (!thread) return;
        // `scrollTo` does not exist everywhere (jsdom included): the position is
        // what matters, the smoothness is a bonus.
        if (typeof thread.scrollTo === 'function') {
            thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' });
        } else {
            thread.scrollTop = thread.scrollHeight;
        }
    }, [messages.length, inFlight]);

    const readOnly = active !== null && !active.owned;
    const canSend = canWrite && !readOnly && !actions.busy && question.trim().length > 0;

    async function send() {
        const text = question.trim();
        if (!text) return;

        let conversationId = activeId;
        if (conversationId === null) {
            const created = await actions.createConversation();
            if (!created) return;
            conversationId = created.id;
            setActiveId(created.id);
        }

        setQuestion('');
        setInFlight(text);
        const answer = await actions.ask(conversationId, text);
        setInFlight(null);
        // The question did not go through: give it back to the composer, do not lose it.
        if (!answer) setQuestion(text);
    }

    async function startConversation() {
        const created = await actions.createConversation();
        if (created) {
            setActiveId(created.id);
            setQuestion('');
        }
    }

    if (conversations.isLoading) return <Loading />;
    if (conversations.isError && !conversations.data) return <ErrorState error={conversations.error} />;

    return (
        <div className="bard-page">
            {/* The same header every other campaign page uses: the Bardo had a
                bare heading and read as a page from another app. */}
            <header className="entity-page-header">
                <span className="entity-page-header__icon" aria-hidden="true">
                    <Icon name="sparkles" />
                </span>
                <div>
                    <h1>{t.bard.title}</h1>
                    <p>{t.bard.intro}</p>
                </div>
            </header>

            <div className="bard-layout">
                <aside className="bard-rail" aria-label={t.bard.conversations}>
                    <button
                        type="button"
                        className="primary bard-rail__new"
                        onClick={startConversation}
                        disabled={!canWrite || actions.busy}
                    >
                        {t.bard.newConversation}
                    </button>

                    {items.length === 0 ? (
                        <Empty message={t.bard.noConversations} />
                    ) : (
                        <ul className="bard-rail__list">
                            {items.map((item) => (
                                <li key={item.id}>
                                    <button
                                        type="button"
                                        className={`bard-rail__item${item.id === activeId ? ' is-active' : ''}`}
                                        onClick={() => setActiveId(item.id)}
                                        aria-current={item.id === activeId}
                                    >
                                        <span className="bard-rail__title">{item.title || t.bard.untitled}</span>
                                        <span className="bard-rail__meta">
                                            {new Date(item.updated_at).toLocaleDateString(locale)}
                                            {item.shared && (
                                                <span className="bard-rail__badge">
                                                    {item.owned ? t.bard.sharedBadge : t.bard.sharedByOther}
                                                </span>
                                            )}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </aside>

                <section className="bard-thread-panel" aria-label={active?.title || t.bard.title}>
                    {active && active.owned && (
                        <div className="bard-thread-panel__actions">
                            {renamingId === active.id ? (
                                <form
                                    className="bard-rename"
                                    onSubmit={async (event) => {
                                        event.preventDefault();
                                        const title = renameDraft.trim();
                                        if (title) await actions.rename(active.id, title);
                                        setRenamingId(null);
                                    }}
                                >
                                    <label className="visually-hidden" htmlFor="bard-rename-input">
                                        {t.bard.renameLabel}
                                    </label>
                                    <input
                                        id="bard-rename-input"
                                        value={renameDraft}
                                        maxLength={120}
                                        onChange={(event) => setRenameDraft(event.target.value)}
                                        autoFocus
                                    />
                                    <button type="submit" className="primary" disabled={actions.busy}>
                                        {t.bard.confirmRename}
                                    </button>
                                    <button type="button" onClick={() => setRenamingId(null)} disabled={actions.busy}>
                                        {t.common.close}
                                    </button>
                                </form>
                            ) : (
                                <>
                                    <h2 className="bard-thread-panel__title">{active.title || t.bard.untitled}</h2>
                                    <div className="bard-thread-panel__buttons">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setRenameDraft(active.title);
                                                setRenamingId(active.id);
                                            }}
                                        >
                                            {t.bard.rename}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => actions.setShared(active.id, !active.shared)}
                                            disabled={actions.busy}
                                        >
                                            {active.shared ? t.bard.unshare : t.bard.share}
                                        </button>
                                        <button
                                            type="button"
                                            className="danger-button"
                                            onClick={() => setPendingDelete(active)}
                                        >
                                            {t.bard.deleteConversation}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    <div className="bard-thread" ref={threadRef}>
                        {active === null ? (
                            <Empty message={t.bard.selectConversation} />
                        ) : messages.length === 0 && inFlight === null ? (
                            <Empty message={t.bard.emptyThread} />
                        ) : (
                            <>
                                {messages.map((message) => (
                                    <Exchange key={message.id} message={message} you={t.bard.you} />
                                ))}
                                {inFlight !== null && (
                                    <>
                                        <article className="bard-question">
                                            <p className="bard-question__who">{t.bard.you}</p>
                                            <p className="bard-question__text">{inFlight}</p>
                                        </article>
                                        <p className="bard-thinking" role="status">
                                            <Icon name="sparkles" />
                                            {t.bard.thinking}
                                        </p>
                                    </>
                                )}
                            </>
                        )}
                    </div>

                    {readOnly ? (
                        <p className="bard-readonly">{t.bard.readOnly}</p>
                    ) : (
                        <form
                            className="bard-composer"
                            onSubmit={(event) => {
                                event.preventDefault();
                                if (canSend) void send();
                            }}
                        >
                            <label className="visually-hidden" htmlFor="bard-question">
                                {t.bard.placeholder}
                            </label>
                            <textarea
                                id="bard-question"
                                value={question}
                                placeholder={t.bard.placeholder}
                                maxLength={2000}
                                rows={3}
                                disabled={!canWrite || actions.busy}
                                onChange={(event) => setQuestion(event.target.value)}
                                onKeyDown={(event) => {
                                    // Enter sends, Shift+Enter is a line break: it is the
                                    // gesture a chat is expected to have.
                                    if (event.key === 'Enter' && !event.shiftKey) {
                                        event.preventDefault();
                                        if (canSend) void send();
                                    }
                                }}
                            />

                            <div className="bard-cost">
                                <CostLine estimate={estimate.data} />
                                <button type="submit" className="primary bard-cost__send" disabled={!canSend}>
                                    {t.bard.send}
                                </button>
                            </div>

                            <FormFeedback error={actions.error} />
                        </form>
                    )}
                </section>
            </div>

            <ConfirmModal
                open={pendingDelete !== null}
                title={t.bard.deleteConversation}
                question={pendingDelete ? t.bard.deleteConfirm(pendingDelete.title || t.bard.untitled) : ''}
                busy={actions.busy}
                error={actions.error}
                confirmLabel={t.bard.deleteConversation}
                busyLabel={t.common.loading}
                onClose={() => setPendingDelete(null)}
                onConfirm={async () => {
                    if (!pendingDelete) return;
                    await actions.remove(pendingDelete.id);
                    if (activeId === pendingDelete.id) setActiveId(null);
                    setPendingDelete(null);
                }}
            />
        </div>
    );

    function Exchange({ message, you }: { message: AskMessage; you: string }) {
        if (message.role === 'user') {
            return (
                <article className="bard-question">
                    <p className="bard-question__who">{you}</p>
                    <p className="bard-question__text">{message.content}</p>
                </article>
            );
        }
        return (
            <article className="bard-answer">
                {message.content.split(/\n{2,}/).map((paragraph, index) => (
                    <p key={index}>{paragraph}</p>
                ))}
                <p className="bard-answer__meta">
                    {message.cost_usd !== null && message.cost_usd > 0 && (
                        <span>{t.bard.charged(formatAiMoney(
                            message.cost_eur ?? message.cost_usd,
                            message.cost_eur !== null ? 'EUR' : 'USD',
                            locale,
                        ))}</span>
                    )}
                    {message.model && <span>{t.bard.answeredBy(message.model)}</span>}
                </p>
            </article>
        );
    }

    /**
     * The cost line: always visible, never a tooltip.
     *
     * Under BYOK it says which of the user's accounts the spend will go to,
     * before the question leaves for the model.
     */
    function CostLine({ estimate: data }: { estimate?: AskEstimate }) {
        if (!data) return <span className="bard-cost__line">{t.common.loading}</span>;
        return (
            <span className="bard-cost__line">
                <span className="bard-cost__price">{t.bard.costLine(data.provider, data.model)}</span>
            </span>
        );
    }
}
