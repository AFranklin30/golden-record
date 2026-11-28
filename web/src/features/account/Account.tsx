import { FormEvent, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { Badge, Banner, Button, Field, PageHeader } from '../../components/ui';
import { loadSession, sessionKey, type OperatorRole } from '../session/session';

type OperatorRow = {
  id: string;
  email: string;
  role: OperatorRole;
  is_active: boolean;
  created_at: string;
};

export function Account() {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: sessionKey, queryFn: loadSession, retry: false });
  const isAdmin = session.data?.role === 'admin';

  const operators = useQuery({
    queryKey: ['operators'],
    queryFn: () => api<{ operators: OperatorRow[] }>('/v1/dashboard/operators'),
    enabled: isAdmin,
  });

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<OperatorRole>('operator');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    setPending(true);
    try {
      await api('/v1/dashboard/operators', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password, role }),
      });
      setEmail('');
      setPassword('');
      setRole('operator');
      setMessage('Operator added.');
      await queryClient.invalidateQueries({ queryKey: ['operators'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operator could not be added.');
    } finally {
      setPending(false);
    }
  }

  async function onDeactivate(id: string) {
    setError('');
    setMessage('');
    setPending(true);
    try {
      await api(`/v1/dashboard/operators/${id}/deactivate`, { method: 'POST', body: '{}' });
      setMessage('Operator deactivated.');
      await queryClient.invalidateQueries({ queryKey: ['operators'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operator could not be deactivated.');
    } finally {
      setPending(false);
    }
  }

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
          {session.data.role ? (
            <p>
              Role:{' '}
              <Badge kind={session.data.role === 'admin' ? 'ok' : 'neutral'}>
                {session.data.role === 'admin' ? 'Administrator' : 'Operator'}
              </Badge>
            </p>
          ) : null}
        </section>
      )}
      {isAdmin ? (
        <section className="panel stack" aria-label="Organization operators">
          <h2>Operators</h2>
          <form className="stack" onSubmit={onAdd}>
            <div className="row">
              <Field label="Operator email">
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </Field>
              <Field label="Temporary password">
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={8}
                  required
                />
              </Field>
              <Field label="Role">
                <select value={role} onChange={(event) => setRole(event.target.value as OperatorRole)}>
                  <option value="operator">Operator</option>
                  <option value="admin">Administrator</option>
                </select>
              </Field>
            </div>
            <div className="row">
              <Button type="submit" disabled={pending}>Add operator</Button>
            </div>
          </form>
          {message ? <Banner kind="ok">{message}</Banner> : null}
          {error ? <Banner kind="error">{error}</Banner> : null}
          {operators.isLoading ? <p>Loading operators.</p> : null}
          {operators.isError ? <Banner kind="error">Operators could not be loaded.</Banner> : null}
          {operators.data ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Email</th><th>Role</th><th>Status</th><th>Action</th></tr>
                </thead>
                <tbody>
                  {operators.data.operators.map((op) => (
                    <tr key={op.id}>
                      <td>{op.email}</td>
                      <td>{op.role === 'admin' ? 'Administrator' : 'Operator'}</td>
                      <td><Badge kind={op.is_active ? 'ok' : 'neutral'}>{op.is_active ? 'Active' : 'Inactive'}</Badge></td>
                      <td>
                        {op.is_active && op.id !== session.data?.operator_id ? (
                          <Button type="button" secondary disabled={pending} onClick={() => onDeactivate(op.id)}>
                            Deactivate
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
