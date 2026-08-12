import { Link } from 'react-router-dom';
import { Icon, type IconName } from './icons';

/** A counter that navigates to what it counts — a number you cannot click is a dead end. */
export function StatTile({ to, value, label, icon }: { to: string; value: number | string; label: string; icon: IconName }) {
    return (
        <Link to={to} className="stat-tile">
            <Icon name={icon} className="stat-tile__icon" />
            <span className="count-value">{value}</span>
            <span className="label">{label}</span>
        </Link>
    );
}
