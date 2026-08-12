import { Link } from 'react-router-dom';
import { useGuilds } from '../api/hooks';
import { useT } from '../i18n';
import { Badge } from '../components/Badge';
import { Empty, ErrorState, Loading } from '../components/StateViews';

export function GuildsPage() {
    const { data: guilds, isLoading, isError, error } = useGuilds();
    const t = useT();

    if (isLoading) return <Loading />;
    if (isError && !guilds) return <ErrorState error={error} />;
    if (!guilds || guilds.length === 0) return <Empty message={t.guilds.empty} />;

    return (
        <div>
            <h1>{t.guilds.title}</h1>
            <p className="subtitle">{t.guilds.subtitle}</p>
            <ul className="card-list guild-card-list">
                {guilds.map((guild) => (
                    <li key={guild.id}>
                        <Link to={`/guilds/${guild.id}/campaigns`} className="card">
                            <span className="monogram guild-monogram" aria-hidden="true">
                                {guild.name.slice(0, 2).toUpperCase()}
                            </span>
                            <span className="card-title guild-card-title">{guild.name}</span>
                            {guild.canManage && <Badge tone="accent">{t.guilds.manage}</Badge>}
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}
