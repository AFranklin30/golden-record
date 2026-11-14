import { FormEvent, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Field } from '../../components/ui';
import { loadSession, safeReturnPath, sessionKey, signIn, signInFailureMessage, signInProblems } from './session';

function signInState(state: unknown) {
  const record = state && typeof state === 'object' ? state as { notice?: unknown; from?: unknown } : {};
  return {
    notice: typeof record.notice === 'string' ? record.notice : '',
    from: safeReturnPath(record.from),
  };
}

export function SignIn() {
  const navigate = useNavigate();
  const location = useLocation();
  const { notice, from } = signInState(location.state);
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: sessionKey, queryFn: loadSession, retry: false });
  const signedIn = session.isSuccess && Boolean(session.data);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (signedIn) navigate(from);
  }, [signedIn, from, navigate]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const problems = signInProblems(email, password);
    if (problems.length > 0) {
      setError(problems.join(' '));
      return;
    }
    setError('');
    setPending(true);
    try {
      await signIn(email.trim(), password);
      await queryClient.invalidateQueries({ queryKey: sessionKey });
      navigate(from);
    } catch (err) {
      setError(signInFailureMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (session.isLoading) return <p className="main">Checking your session.</p>;
  if (signedIn) return <p className="main">Opening your dashboard.</p>;

  return (
    <main className="sign-in panel">
      <form className="stack" onSubmit={onSubmit} aria-busy={pending} noValidate>
        <p className="brand-mark">Golden Record</p>
        <h1>Sign in</h1>
        {notice ? <Banner kind="empty">{notice}</Banner> : null}
        <Field label="Email">
          <input
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Password">
          <span className="password-field">
            <input
              aria-label="Password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              className="secondary"
              type="button"
              aria-pressed={showPassword}
              onClick={() => setShowPassword((current) => !current)}
            >
              {showPassword ? 'Hide password' : 'Show password'}
            </button>
          </span>
        </Field>
        {error ? <Banner kind="error">{error}</Banner> : null}
        <Button type="submit" disabled={pending}>{pending ? 'Signing in' : 'Sign in'}</Button>
      </form>
    </main>
  );
}
