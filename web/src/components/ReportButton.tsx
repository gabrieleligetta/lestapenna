import { useT } from '../i18n';
import { Icon } from './icons';

/** Red header button that opens the report modal. Sits left of the theme toggle. */
export function ReportButton({ onClick }: { onClick: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            className="icon-button icon-button--danger"
            onClick={onClick}
            aria-label={t.report.buttonLabel}
            title={t.report.buttonLabel}
        >
            <Icon name="flag" />
        </button>
    );
}