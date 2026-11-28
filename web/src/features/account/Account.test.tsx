import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createQueryClient } from '../../queryClient';
import { Account } from './Account';

function json(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function renderAccount() {
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <Account />
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Account operator management', () => {
  test('administrator sees operators panel and can add or deactivate another operator', async () => {
    const operators = [
      { id: 'op-1', email: 'admin@example.com', role: 'admin', is_active: true, created_at: '2026-11-27T00:00:00Z' },
      { id: 'op-2', email: 'staff@example.com', role: 'operator', is_active: true, created_at: '2026-11-27T01:00:00Z' },
    ];
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (String(path) === '/v1/dashboard/session') {
        return json(200, {
          operator_id: 'op-1',
          email: 'admin@example.com',
          role: 'admin',
          org_name: 'Demo Org',
        });
      }
      if (String(path) === '/v1/dashboard/operators' && init?.method === 'POST') {
        operators.push({
          id: 'op-3',
          email: 'new@example.com',
          role: 'operator',
          is_active: true,
          created_at: '2026-11-27T02:00:00Z',
        });
        return json(201, { operator: operators[2] });
      }
      if (String(path) === '/v1/dashboard/operators/op-2/deactivate' && init?.method === 'POST') {
        operators[1].is_active = false;
        return json(200, { operator: operators[1] });
      }
      if (String(path) === '/v1/dashboard/operators') {
        return json(200, { operators: [...operators] });
      }
      return json(404, { error: 'not found' });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAccount();
    expect(await screen.findByText('Signed in as admin@example.com')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Operators' })).toBeInTheDocument();
    expect(await screen.findByText('staff@example.com')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Operator email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('Temporary password'), { target: { value: 'super-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add operator' }));
    expect(await screen.findByText('Operator added.')).toBeInTheDocument();
    expect(await screen.findByText('new@example.com')).toBeInTheDocument();

    const deactivateButtons = screen.getAllByRole('button', { name: 'Deactivate' });
    fireEvent.click(deactivateButtons[0]);
    expect(await screen.findByText('Operator deactivated.')).toBeInTheDocument();
  });

  test('regular operator does not see operator management controls', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      if (String(path) === '/v1/dashboard/session') {
        return json(200, {
          operator_id: 'op-2',
          email: 'staff@example.com',
          role: 'operator',
          org_name: 'Demo Org',
        });
      }
      return json(403, { error: 'forbidden' });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderAccount();
    expect(await screen.findByText('Signed in as staff@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Operators' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/operators'))).toBe(false);
  });
});
