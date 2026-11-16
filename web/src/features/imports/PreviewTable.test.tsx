import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PreviewTable } from './PreviewTable';
import { Banner } from '../../components/ui';

describe('import states', () => {
  it('shows an empty preview', () => {
    render(<PreviewTable rows={[]} errorCount={0} />);
    expect(screen.getByRole('status').textContent).toMatch(/No data rows/);
  });

  it('shows a row error without treating the whole file as failed', () => {
    render(
      <PreviewTable
        errorCount={1}
        rows={[{
          row_number: 2,
          status: 'error',
          error: 'row needs an email, or a name and a birthday',
          values: { first_name: 'Ada', last_name: '', email: '' },
        }]}
      />
    );
    expect(screen.getByRole('alert').textContent).toMatch(/1 row needs/);
    expect(screen.getByText('row needs an email, or a name and a birthday')).toBeTruthy();
  });

  it('shows success when every row is ready', () => {
    render(
      <PreviewTable
        errorCount={0}
        rows={[{
          row_number: 1,
          status: 'ok',
          error: null,
          values: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
        }]}
      />
    );
    expect(screen.getByRole('status').textContent).toMatch(/can be imported/);
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  it('uses a status role for an empty list elsewhere', () => {
    render(<Banner kind="empty">No imports yet.</Banner>);
    expect(screen.getByRole('status').textContent).toBe('No imports yet.');
  });
});
