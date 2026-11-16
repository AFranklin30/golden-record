import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test } from 'vitest';
import { reviewNote, type ImportedRecord } from './RecordList';

function record(opened: boolean): ImportedRecord {
  return {
    import_row_id: '11111111-1111-4111-8111-111111111111',
    batch_id: '22222222-2222-4222-8222-222222222222',
    filename: 'customers.csv',
    row_number: 1,
    status: 'complete',
    fan_id: opened ? '33333333-3333-4333-8333-333333333333' : '33333333-3333-4333-8333-333333333333',
    deleted_at: null,
    resolution_path: opened ? 'D' : 'B',
    conflict_id: opened ? '44444444-4444-4444-8444-444444444444' : null,
    conflict_status: opened ? 'pending' : null,
    confidence_score: opened ? 0.4 : null,
    error: null,
    person: { name: ['Ada Lovelace'], email: ['ada@example.com'] },
    review_opened: opened,
  };
}

describe('imported record review copy', () => {
  test('a row with no conflict says no review was opened', () => {
    render(<p>{reviewNote(record(false))}</p>, { wrapper: MemoryRouter });
    expect(screen.getByText('No review was opened')).toBeInTheDocument();
    expect(screen.queryByText(/unique/i)).not.toBeInTheDocument();
  });

  test('a flagged row says a review was opened', () => {
    expect(reviewNote(record(true))).toBe('Review opened');
  });
});
