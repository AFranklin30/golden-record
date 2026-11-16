import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import { createQueryClient } from '../../queryClient';
import { ReviewDetail } from './ReviewDetail';
import { ReviewList } from './ReviewList';

const pendingId = '11111111-1111-4111-8111-111111111111';
const confirmedId = '22222222-2222-4222-8222-222222222222';

function json(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function person(name: string, email: string) {
  return { name: [name], email: [email], dob: ['1990-04-02'], zip: ['73101'], phone: [] };
}

function review(id: string, status: string, left: string, right: string) {
  return {
    conflict_id: id,
    status,
    confidence_score: 0.4,
    signals_matched: [{ signal: 'name_plus_dob' }],
    reviewed_at: status === 'pending' ? null : '2026-11-14T06:00:00.000Z',
    person_a: person(left, `${left.split(' ')[0].toLowerCase()}@example.com`),
    person_b: person(right, `${right.split(' ')[0].toLowerCase()}@example.com`),
  };
}

function renderQueue() {
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/reviews']}>
        <Routes>
          <Route path="/reviews" element={<ReviewList />} />
          <Route path="/reviews/:id" element={<ReviewDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderReview(id: string) {
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/reviews/${id}`]}>
        <Routes>
          <Route path="/reviews/:id" element={<ReviewDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('review queue', () => {
  test('pending is the default, and confirmed or rejected rows open from their own view', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      const url = String(path);
      if (url.includes('status=confirmed')) {
        return json(200, { reviews: [review(confirmedId, 'confirmed', 'Ada Lovelace', 'A Lovelace')] });
      }
      if (url.includes('status=rejected')) {
        return json(200, { reviews: [review(pendingId, 'rejected', 'Grace Hopper', 'G Hopper')] });
      }
      if (url.includes(`/reviews/${confirmedId}`)) {
        return json(200, review(confirmedId, 'confirmed', 'Ada Lovelace', 'A Lovelace'));
      }
      return json(200, { reviews: [review(pendingId, 'pending', 'Jane Doe', 'Jane Doe')] });
    }));

    renderQueue();
    expect(await screen.findByRole('button', { name: 'Pending', pressed: true })).toBeInTheDocument();
    expect((await screen.findAllByText('Jane Doe')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirmed' }));
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0);
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Open' }));
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo merge' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Back to the queue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rejected' }));
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
  });
});

describe('review decision', () => {
  test('a pending review can merge or stay separate, and undo is absent', async () => {
    const calls: string[] = [];
    let current = review(pendingId, 'pending', 'Jane Doe', 'Jane Doe');
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      const url = String(_path);
      if (init?.method === 'POST' && url.endsWith('/confirm')) {
        calls.push('confirm');
        current = { ...current, status: 'confirmed', reviewed_at: '2026-11-14T06:00:00.000Z' };
        return json(200, { status: 'confirmed' });
      }
      if (init?.method === 'POST' && url.endsWith('/reject')) {
        calls.push('reject');
        current = { ...current, status: 'rejected' };
        return json(200, { status: 'rejected' });
      }
      return json(200, current);
    }));

    renderReview(pendingId);
    expect(await screen.findByRole('button', { name: 'Confirm same person' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep separate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo merge' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm same person' }));
    expect(screen.getByRole('heading', { name: 'Merge these records?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect((await screen.findAllByText('These records were merged.')).length).toBeGreaterThan(0);
    expect(calls).toEqual(['confirm']);
  });

  test('undo merge asks first, then shows the reversed status', async () => {
    let current = review(confirmedId, 'confirmed', 'Ada Lovelace', 'A Lovelace');
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        current = { ...current, status: 'unmerged' };
        return json(200, { status: 'unmerged' });
      }
      return json(200, current);
    }));

    renderReview(confirmedId);
    expect(await screen.findByText('These records were merged.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm same person' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo merge' }));
    expect(screen.getByRole('heading', { name: 'Undo this merge?' })).toBeInTheDocument();
    expect(screen.getByText(/separated again/)).toBeInTheDocument();
    const confirmUndo = screen.getAllByRole('button', { name: 'Undo merge' }).at(-1);
    if (!confirmUndo) throw new Error('missing confirm button');
    fireEvent.click(confirmUndo);
    expect((await screen.findAllByText('A previous merge was reversed. These records are separate again.')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Undo merge' })).not.toBeInTheDocument();
  });

  test('a failed undo stays on the page and a second click does not send another request', async () => {
    let posts = 0;
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts += 1;
        if (posts === 1) {
          await gate;
          return json(409, { error: 'unmerge already completed' });
        }
        return json(500, { error: 'should not be called' });
      }
      return json(200, review(confirmedId, 'confirmed', 'Ada Lovelace', 'A Lovelace'));
    }));

    renderReview(confirmedId);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo merge' }));
    const confirm = screen.getAllByRole('button', { name: 'Undo merge' }).at(-1);
    if (!confirm) throw new Error('missing confirm button');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    release(undefined);
    expect(await screen.findByText('unmerge already completed')).toBeInTheDocument();
    expect(posts).toBe(1);
  });

  test('a rejected review explains that the records stayed separate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, review(pendingId, 'rejected', 'Grace Hopper', 'G Hopper'))));
    renderReview(pendingId);
    expect(await screen.findByText('These records were kept separate.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo merge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm same person' })).not.toBeInTheDocument();
  });
});
