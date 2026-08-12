/**
 * What a form has to say after you press save: the failure, or the confirmation.
 *
 * The pair was written out by hand in eleven places, each choosing its own
 * `role` and its own order, so an error announced itself in some panels and not
 * in others. One component keeps the two live regions correct everywhere.
 *
 * Both are optional and both may be absent: a form that has not been submitted
 * yet renders nothing at all rather than an empty reserved row.
 */
export function FormFeedback({
    error,
    saved,
    savedLabel,
}: {
    /** The failure, already localised or straight from the API. */
    error?: string | null;
    /** Whether the last submission succeeded. */
    saved?: boolean;
    /** What to say when it did. */
    savedLabel?: string;
}) {
    return (
        <>
            {error && <p className="form-error" role="alert">{error}</p>}
            {saved && savedLabel && <p className="status" role="status">{savedLabel}</p>}
        </>
    );
}
