import { ApiError } from './client';
import type { Messages } from '../i18n/messages';

/**
 * What to show when an action fails.
 *
 * The backend's own sentence is usually the best thing available — it names the
 * model that no longer exists, the parameter that was wrong, the key that is
 * out of credit — so it is the default, exactly as before.
 *
 * The exception is 502, which the API sends when the *provider* faltered. There
 * the message would be about a machine at Google being busy, in English, and
 * the person reading it can do nothing with it beyond clicking again. One table
 * reported precisely this as a bug in the product, which is what it looked
 * like: so it gets a sentence of ours, in their language, that says nothing is
 * broken. A 503 is deliberately left alone — in these routes it means this
 * instance has no media storage configured, which clicking again will not fix.
 */
export function actionErrorMessage(reason: unknown, t: Messages): string {
    if (reason instanceof ApiError && reason.status === 502) return t.errors.providerBusy;
    return reason instanceof Error ? reason.message : t.common.error;
}
