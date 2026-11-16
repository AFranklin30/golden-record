import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import { createQueryClient } from '../../queryClient';
import { ImportDetail } from './ImportDetail';

const batchId = '22222222-2222-4222-8222-222222222222';

function json(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function detail(removed: string | null) {
  return {
    import: {
      id: batchId,
      filename: 'customers.csv',
      created_at: '2026-11-14T12:00:00.000Z',
      data_removed_at: removed,
    },
    rows: [{
      id: '11111111-1111-4111-8111-111111111111',
      row_number: 1,
      status: 'complete',
      fan_id: '33333333-3333-4333-8333-333333333333',
      resolution_path: 'B',
      conflict_id: null,
      error: null,
    }],
  };
}

describe('import hide', () => {
  test('requires the filename before hiding people added by the file', async () => {
    let removed = false;
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (String(path).endsWith('/remove') && init?.method === 'POST') {
        removed = true;
        return json(200, {
          removed: [{ row_number: 1, fan_id: '33333333-3333-4333-8333-333333333333' }],
          left_in_place: [],
          skipped: [],
        });
      }
      return json(200, detail(removed ? '2026-11-14T12:00:00.000Z' : null));
    }));

    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[`/imports/${batchId}`]}>
          <Routes>
            <Route path="/imports/:id" element={<ImportDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Hide people added by this file' }));
    const confirm = screen.getByRole('button', { name: 'Hide these people' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Filename confirmation'), { target: { value: 'customers.csv' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    expect(await screen.findByText('People added by this file are hidden. The file stays in history.')).toBeInTheDocument();
    expect(screen.getByText('1 hidden. 0 left in place. 0 skipped.')).toBeInTheDocument();
  });
});