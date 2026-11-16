import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ImportList } from '../features/imports/ImportList';
import { ReviewDetail } from '../features/reviews/ReviewDetail';
import { safeReturnPath, sessionKey } from '../features/session/session';
import { SignIn } from '../features/session/SignIn';
import { createQueryClient } from '../queryClient';
import { RequireSession } from './Shell';

const reviewId = '11111111-1111-4111-8111-111111111111';

function json(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function renderAt(path: string) {
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route element={<RequireSession />}>
            <Route path="/imports" element={<ImportList />} />
            <Route path="/reviews/:id" element={<ReviewDetail />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('safeReturnPath', () => {
  test('keeps an in-app path and drops an outside address', () => {
    expect(safeReturnPath('/reviews/abc')).toBe('/reviews/abc');
    expect(safeReturnPath('https://evil.test')).toBe('/imports');
    expect(safeReturnPath('//evil.test')).toBe('/imports');
    expect(safeReturnPath('/sign-in')).toBe('/imports');
  });
});

describe('route guard', () => {
  test('an unsigned visit to a protected page opens the sign-in form', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: 'unauthorized', message: 'sign in required' })));
    renderAt('/imports');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Imports' })).not.toBeInTheDocument();
  });

  test('a session that ends explains why the sign-in form is back', async () => {
    let open = true;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).includes('/imports')) return json(200, { imports: [] });
      if (!open) return json(401, { error: 'unauthorized', message: 'sign in required' });
      return json(200, { email: 'ada@example.com', org_name: 'North' });
    }));
    const client = renderAt('/imports');
    expect(await screen.findByRole('heading', { name: 'Imports' })).toBeInTheDocument();
    open = false;
    await client.invalidateQueries({ queryKey: sessionKey });
    expect(await screen.findByText('Your session ended. Sign in again.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  test('a network failure while checking the session offers a retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    renderAt('/imports');
    expect(await screen.findByText('The dashboard could not be reached. Check the connection and try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  test('sign-out clears the dashboard and stores nothing', async () => {
    let signedOut = false;
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        signedOut = true;
        return json(200, { signed_out: true });
      }
      if (String(path).includes('/imports')) return json(200, { imports: [] });
      if (signedOut) return json(401, { error: 'unauthorized', message: 'sign in required' });
      return json(200, { email: 'ada@example.com', org_name: 'North' });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/imports');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('You signed out.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Imports' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  test('an unauthorized list request ends the session', async () => {
    let sessionCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (String(path).includes('/imports')) {
        return json(401, { error: 'unauthorized', message: 'sign in required' });
      }
      sessionCalls += 1;
      if (sessionCalls === 1) return json(200, { email: 'ada@example.com', org_name: 'North' });
      return json(401, { error: 'unauthorized', message: 'sign in required' });
    }));
    renderAt('/imports');
    expect(await screen.findByText('Your session ended. Sign in again.')).toBeInTheDocument();
  });

  test('a missing review does not render another organization', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      calls.push([String(path), init]);
      if (String(path).includes('/reviews/')) {
        return json(404, { error: 'review not found', email: 'secret@other.test' });
      }
      return json(200, { email: 'ada@example.com', org_name: 'North' });
    }));
    renderAt(`/reviews/${reviewId}`);
    expect(await screen.findByText('This review could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText(/secret@other.test/)).not.toBeInTheDocument();
    const reviewCall = calls.find((call) => call[0].includes('/reviews/'));
    expect(reviewCall?.[0]).toBe(`/v1/dashboard/reviews/${reviewId}`);
    expect(reviewCall?.[1]?.credentials).toBe('include');
    expect(JSON.stringify(reviewCall?.[1]?.body ?? '')).not.toContain('org_id');
  });

  test('signing in from a review link returns to that review', async () => {
    let signedIn = false;
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        signedIn = true;
        return json(200, { email: 'ada@example.com', org_name: 'North' });
      }
      if (String(path).includes('/reviews/')) {
        return json(404, { error: 'review not found' });
      }
      if (signedIn) return json(200, { email: 'ada@example.com', org_name: 'North' });
      return json(401, { error: 'unauthorized', message: 'sign in required' });
    }));
    renderAt(`/reviews/${reviewId}`);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('This review could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Imports' })).not.toBeInTheDocument();
  });
});
