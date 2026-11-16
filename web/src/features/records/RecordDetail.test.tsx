import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import { createQueryClient } from '../../queryClient';
import { RecordDetail } from './RecordDetail';

const rowId = '11111111-1111-4111-8111-111111111111';
const fanId = '33333333-3333-4333-8333-333333333333';

function json(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function record(deleted: string | null) {
  return {
    record: {
      import_row_id: rowId,
      batch_id: '22222222-2222-4222-8222-222222222222',
      filename: 'customers.csv',
      row_number: 1,
      status: 'complete',
      fan_id: fanId,
      deleted_at: deleted,
      resolution_path: 'B',
      conflict_id: null,
      conflict_status: null,
      confidence_score: null,
      error: null,
      person: { name: ['Ada Lovelace'], email: ['ada@example.com'] },
      review_opened: false,
    },
  };
}

function renderDetail() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/records/${rowId}`]}>
        <Routes>
          <Route path="/records/:id" element={<RecordDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('record hide', () => {
  test('asks for confirmation and then shows the person as hidden', async () => {
    let hidden = false;
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (String(path).endsWith('/hide') && init?.method === 'POST') {
        hidden = true;
        return json(200, { fan_id: fanId, hidden: true });
      }
      return json(200, record(hidden ? '2026-11-14T12:00:00.000Z' : null));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDetail();
    expect(await screen.findByText('No review was opened')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide this person' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('The stored name and email stay in the database.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Hide this person' }).at(-1)!);

    expect(await screen.findByText(/hidden from new matches and from the export/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/v1/dashboard/fans/${fanId}/hide`,
      expect.objectContaining({ method: 'POST' })
    );
  });
});
