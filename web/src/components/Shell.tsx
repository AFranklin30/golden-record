import { useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../api';
import { loadSession, safeReturnPath, sessionKey } from '../features/session/session';
import { Banner, Button } from './ui';

const LINKS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/imports', label: 'Imports', end: false },
  { to: '/reviews', label: 'Review queue', end: false },
  { to: '/exports', label: 'Exports', end: false },
  { to: '/account', label: 'Account', end: false },
];

export function RequireSession() {
  const location = useLocation();
  const hadSession = useRef(false);
  const session = useQuery({
    queryKey: sessionKey,
    queryFn: loadSession,
    retry: false,
  });

  if (session.data) hadSession.current = true;
  if (session.isLoading) return <p className="main">Loading your session.</p>;

  const unauthorized = session.error instanceof ApiError && session.error.kind === 'unauthorized';
  if (session.isError && !unauthorized) {
    const unreachable = session.error instanceof ApiError && session.error.kind === 'network';
    return (
      <main className="main stack">
        <Banner kind="error">
          {unreachable
            ? 'The dashboard could not be reached. Check the connection and try again.'
            : 'The dashboard could not be checked. Try again.'}
        </Banner>
        <Button type="button" onClick={() => session.refetch()}>Try again</Button>
      </main>
    );
  }

  if (session.isError || !session.data) {
    const from = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to="/sign-in"
        replace
        state={{
          from: safeReturnPath(from),
          notice: hadSession.current ? 'Your session ended. Sign in again.' : undefined,
        }}
      />
    );
  }

  return <Shell orgName={session.data.org_name} email={session.data.email} />;
}

function Shell({ orgName, email }: { orgName: string; email: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [signOutError, setSignOutError] = useState('');

  async function signOut() {
    setSignOutError('');
    try {
      await api('/v1/dashboard/session', { method: 'DELETE' });
    } catch {
      setSignOutError('Sign-out could not be completed. Try again.');
      return;
    }
    queryClient.clear();
    navigate('/sign-in', { state: { notice: 'You signed out.' } });
  }

  return (
    <div className="shell">
      <button className="menu-toggle" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        Menu
      </button>
      <aside className={open ? 'sidebar open' : 'sidebar'}>
        <div className="brand">Golden Record</div>
        <nav className="nav" aria-label="Dashboard">
          {LINKS.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.end} onClick={() => setOpen(false)}>{link.label}</NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="org-name">{orgName}</div>
          <div className="org-email">{email}</div>
          <Button secondary type="button" onClick={signOut}>Sign out</Button>
        </div>
      </aside>
      <main className="main">
        {signOutError ? <Banner kind="error">{signOutError}</Banner> : null}
        <Outlet />
      </main>
    </div>
  );
}
