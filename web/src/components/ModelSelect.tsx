import { useId } from 'react';
import type { AiModelOption } from '../api/types';
import { useT } from '../i18n';
import { Badge } from './Badge';
import { formatContext, formatRate } from './aiLabels';

/**
 * Choosing a model, with what it costs in plain sight.
 *
 * A native `<select>` on purpose, like everywhere else in this app: the
 * catalogue is curated down to a handful of entries per group, so there is
 * nothing to search, and a native control is already correct with a keyboard
 * and a screen reader and opens the OS picker on a phone. A hand-rolled
 * combobox would be ARIA to maintain in exchange for nothing.
 *
 * Two things it does that the old bare select did not:
 *
 *  - **the price is in the option**, because cost transparency belongs at the
 *    moment of the choice and not only on the invoice: someone picking here has
 *    to see, right there, that another model costs a tenth as much;
 *  - **an unlisted model is kept and flagged**, rather than silently reset. The
 *    catalogue is curated and not exhaustive, so a saved id it does not carry
 *    may be perfectly valid — or withdrawn. Saying which we cannot tell is
 *    better than either dropping it or pretending it is fine.
 */

const CUSTOM = '__custom';

export function ModelSelect({
    value, options, onChange, disabled = false, allowEmpty = false, emptyLabel, id, ariaLabel,
}: {
    value: string;
    options: AiModelOption[];
    onChange: (model: string) => void;
    disabled?: boolean;
    /** Adds a first entry meaning "no choice" — inherit, or follow the server. */
    allowEmpty?: boolean;
    emptyLabel?: string;
    id?: string;
    /** For the call sites with no visible `<label>` wrapping the control. */
    ariaLabel?: string;
}) {
    const t = useT();
    const generatedId = useId();
    const selectId = id ?? generatedId;

    const known = options.some((option) => option.id === value);
    // Empty is a legitimate "no choice"; a non-empty value we do not know is a
    // model typed by hand, or one the catalogue has dropped.
    const custom = value !== '' && !known;

    const recommended = options.filter((option) => option.recommended);
    const others = options.filter((option) => !option.recommended);

    return (
        <div className="model-select">
            <select
                id={selectId}
                className="model-select__control"
                aria-label={ariaLabel}
                value={custom ? CUSTOM : value}
                disabled={disabled}
                onChange={(event) => onChange(event.target.value === CUSTOM ? '' : event.target.value)}
            >
                {allowEmpty && <option value="">{emptyLabel ?? '—'}</option>}
                {recommended.length > 0 && (
                    <optgroup label={t.aiSettings.groupRecommended}>
                        {recommended.map((option) => (
                            <option key={option.id} value={option.id}>{optionText(option, t)}</option>
                        ))}
                    </optgroup>
                )}
                {others.length > 0 && (
                    <optgroup label={recommended.length > 0 ? t.aiSettings.groupOthers : ''}>
                        {others.map((option) => (
                            <option key={option.id} value={option.id}>{optionText(option, t)}</option>
                        ))}
                    </optgroup>
                )}
                {/* The catalogue is curated, not exhaustive: providers publish
                    new models every month, and someone who knows what they want
                    must be able to type it. */}
                <option value={CUSTOM}>{t.aiSettings.modelCustom}</option>
            </select>

            {custom && (
                <input
                    className="model-select__custom"
                    value={value}
                    disabled={disabled}
                    placeholder={t.aiSettings.modelCustom}
                    aria-label={t.aiSettings.modelCustom}
                    onChange={(event) => onChange(event.target.value)}
                />
            )}

            {custom && value !== '' && options.length > 0 && (
                <p className="model-select__note">
                    <Badge tone="warning">{t.aiSettings.modelUnavailable}</Badge>{' '}
                    {t.aiSettings.modelUnavailableHint}
                </p>
            )}
        </div>
    );
}

/**
 * The text of one option.
 *
 * Everything on one line because a native `<select>` allows nothing else — the
 * reason the price is *also* repeated as structured text under the control,
 * where it can be laid out.
 */
function optionText(option: AiModelOption, t: ReturnType<typeof useT>): string {
    const parts: string[] = [option.id];

    if (option.runs_on_your_hardware) {
        parts.push(t.aiSettings.onYourHardware);
    } else if (option.per_minute_usd !== null) {
        parts.push(t.campaignTranscription.perMinute(`$${option.per_minute_usd.toFixed(4)}`));
    } else if (option.per_image_usd !== null) {
        // A third unit, and the one where the figure matters most: these cost
        // hundreds of times a text call, so the price belongs in the option.
        parts.push(t.aiSettings.perImage(`$${option.per_image_usd.toFixed(3)}`));
    } else if (option.input_per_million !== null && option.output_per_million !== null) {
        parts.push(t.aiSettings.perMillionTokens(
            formatRate(option.input_per_million),
            formatRate(option.output_per_million),
        ));
    } else {
        parts.push(t.aiSettings.priceUnknown);
    }

    if (option.context_tokens) parts.push(t.aiSettings.contextWindow(formatContext(option.context_tokens)));
    if (option.label) parts.push(option.label);

    return parts.join(' · ');
}
