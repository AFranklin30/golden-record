import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SignIn } from './SignIn';

function json(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function renderSignIn() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sign-in']}>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/imports" element={<h1>Imports</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('sign-in', () => {
  test('a correct password opens the dashboard and stores nothing in the browser', async () => {
    let signedIn = false;
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(init.credentials).toBe('include');
        signedIn = true;
        return json(200, { email: 'ada@example.com', org_name: 'North' });
      }
      if (signedIn) return json(200, { email: 'ada@example.com', org_name: 'North' });
      return json(401, { error: 'unauthorized', message: 'sign in required' });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSignIn();
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Imports' })).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    expect(post?.[1]?.body).not.toContain('org_api_key');
  });

  test('invalid credentials use one generic sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return json(401, { error: 'unauthorized', message: 'invalid credentials' });
      }
      return json(401, { error: 'unauthorized', message: 'sign in required' });
    }));

    renderSignIn();
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Those credentials were not accepted.');
    expect(alert.textContent).not.toMatch(/inactive|exist|organization/i);
  });

  test('an empty form and a malformed email do not post', async () => {
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => json(401, { error: 'unauthorized' }));
    vi.stubGlobal('fetch', fetchMock);
    renderSignIn();
    await screen.findByLabelText('Email');

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an email address.');

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an email address.');
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  test('an existing session skips the form', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { email: 'ada@example.com', org_name: 'North' })));
    renderSignIn();
    expect(await screen.findByRole('heading', { name: 'Imports' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  test('a server failure and a network failure are not described as a bad password', async () => {
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      const body = String(init?.body || '');
      if (init?.method === 'POST' && body.includes('server-down')) {
        return json(500, { error: 'internal error' });
      }
      if (init?.method === 'POST' && body.includes('rate-limited')) {
        return json(429, { error: 'Too many requests, please try again later.' });
      }
      if (init?.method === 'POST') throw new TypeError('Failed to fetch');
      return json(401, { error: 'unauthorized', message: 'sign in required' });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderSignIn();
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'server-down-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in could not be completed. Try again.');

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'rate-limited-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in could not be completed. Try again.');

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'offline-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The dashboard could not be reached.');
  });

  test('show and hide change the password field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'unauthorized' })));
    renderSignIn();
    const password = await screen.findByLabelText('Password');
    expect(password).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password).toHaveAttribute('type', 'password');
  });
});
