import { useQuery } from '@tanstack/react-query';
import { Banner, PageHeader } from '../../components/ui';
import { loadSession, sessionKey } from '../session/session';

export function Account() {
  const session = useQuery({ queryKey: sessionKey, queryFn: loadSession, retry: false });

  return (
    <div className="stack">
      <PageHeader
        title="Account"
        lede="The organization this sign-in can see. The organization API key stays on the server."
      />
      {session.isLoading ? <p>Loading your account.</p> : null}
      {session.isError || !session.data ? <Banner kind="error">Account details could not be loaded.</Banner> : (
        <section className="panel stack">
          <h2>{session.data.org_name}</h2>
          <p>Signed in as {session.data.email}</p>
        </section>
      )}
    </div>
  );
}
