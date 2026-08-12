import { Badge } from './Badge';
import { Icon } from './icons';
import { useT } from '../i18n';
import { statusLabel, statusPresentation } from './statusPresentation';

export function StatusBadge({ status }: { status: string | null | undefined }) {
    const t = useT();
    if (!status) return <span className="muted">—</span>;

    const presentation = statusPresentation(status);
    const label = statusLabel(t, status);

    return (
        <Badge tone={presentation.tone}>
            <Icon name={presentation.icon} className="badge-icon" />
            <span>{label}</span>
        </Badge>
    );
}
