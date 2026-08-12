import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMe } from '../api/hooks';
import { Loading } from '../components/StateViews';
import { rememberReturnPath } from '../returnPath';

/**
 * Auth gate for every route below it. Renders <Outlet/> rather than children so
 * it can sit in the route table as a layout route, which is what lets the shell
 * mount once instead of per page.
 */
export function RequireAuth() {
    const { data: me, isLoading } = useMe();
    const location = useLocation();

    if (isLoading) return <Loading />;

    // A network error during a refetch does not cancel an already loaded
    // session; the APIs keep enforcing authentication regardless.
    if (!me) {
        // Written during render on purpose: this is the last moment the intended
        // destination exists, and the write is idempotent, so StrictMode's double
        // render is harmless.
        rememberReturnPath(location.pathname + location.search);
        return <Navigate to="/" replace />;
    }

    return <Outlet />;
}
