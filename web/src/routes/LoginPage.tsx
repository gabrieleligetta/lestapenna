import { Navigate } from 'react-router-dom';
import { useMe } from '../api/hooks';
import { loginUrl } from '../api/client';
import { useT } from '../i18n';
import { peekReturnPath } from '../returnPath';
import { Loading } from '../components/StateViews';
import { SupportBar } from '../components/SupportBar';
import { LoginDonationButtons } from '../components/LoginDonationButtons';

export function LoginPage() {
    const { data: me, isLoading } = useMe();
    const t = useT();

    if (isLoading) return <Loading />;
    // Discord's callback always drops the user on /app, so the page they
    // actually asked for is restored here. AppShell clears it once we land.
    if (me) return <Navigate to={peekReturnPath() ?? '/guilds'} replace />;

    return (
        <div className="login-page">
            <div className="login-gate">
                <img
                    className="login-mark"
                    src={`${import.meta.env.BASE_URL}assets/mark.svg`}
                    alt=""
                    width="80"
                    height="80"
                />
                <h1>{t.login.title}</h1>
                <p>{t.login.subtitle}</p>
                <a className="button-discord" href={loginUrl()}>
                    {t.login.cta}
                </a>
                <LoginDonationButtons />
            </div>
            <SupportBar />
        </div>
    );
}
