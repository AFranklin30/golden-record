import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { Banner, Button, Field, PageHeader } from '../../components/ui';

type Detail = {
  import: { id: string; filename: string | null; created_at: string; data_removed_at: string | null };
  rows: Array<{
    id: string;
    row_number: number;
    status: string;
    fan_id: string | null;
    resolution_path: string | null;
    conflict_id: string | null;
    error: string | null;
  }>;
};

type Removal = {
  removed: Array<{ row_number: number; fan_id: string }>;
  left_in_place: Array<{ row_number: number; fan_id: string | null; reason: string }>;
  skipped: Array<{ row_number: number; fan_id: string; reason: string }>;
};

export function ImportDetail() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Removal | null>(null);
  const busy = useRef(false);
  const detail = useQuery({
    queryKey: ['import', id],
    queryFn: () => api<Detail>(`/v1/dashboard/imports/${id}`),
  });

  if (detail.isLoading) return <p>Loading this import.</p>;
  if (detail.isError || !detail.data) return <Banner kind="error">This import could not be loaded.</Banner>;

  const file = detail.data.import;
  const expected = file.filename || 'Untitled import';
  const rows = detail.data.rows;
  const errors = rows.filter((row) => row.status === 'error');

  async function removePeople() {
    if (busy.current || typed !== expected) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const body = await api<Removal>(`/v1/dashboard/imports/${id}/remove`, {
        method: 'POST',
        body: JSON.stringify({ confirm_filename: typed }),
      });
      setResult(body);
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['import', id] });
      await queryClient.invalidateQueries({ queryKey: ['imports'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'These people could not be hidden.');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title={file.filename || 'Import'}
        lede="Each row shows the path the server returned. A review link is a possible match, not a merge."
      />
      {file.data_removed_at ? (
        <Banner kind="ok">People added by this file are hidden. The file stays in history.</Banner>
      ) : null}
      {rows.length === 0
        ? <Banner kind="empty">This import has no rows.</Banner>
        : <Banner kind={errors.length ? 'error' : 'ok'}>{rows.length - errors.length} stored. {errors.length} could not be stored. Nothing was merged automatically.</Banner>}
      {error ? <Banner kind="error">{error}</Banner> : null}
      {result ? (
        <Banner kind="ok">
          {result.removed.length} hidden. {result.left_in_place.length} left in place. {result.skipped.length} skipped.
        </Banner>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Row</th><th>Status</th><th>Path</th><th>Review</th><th>Record</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.row_number}>
                <td>{row.row_number}</td>
                <td>{row.error || row.status}</td>
                <td>{row.resolution_path || ''}</td>
                <td>{row.conflict_id ? <Link to={`/reviews/${row.conflict_id}`}>Open review</Link> : ''}</td>
                <td>{row.fan_id ? <Link to={`/records/${row.id}`}>Open record</Link> : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {file.data_removed_at ? null : (
        <Button type="button" secondary onClick={() => setOpen(true)}>Hide people added by this file</Button>
      )}
      {open ? (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="remove-title">
            <h2 id="remove-title">Hide people added by this file?</h2>
            <p>People this file created are hidden from new matches and from the export. A person who already existed is left alone. The file stays in history. Type the filename to continue.</p>
            <Field label="Filename">
              <input value={typed} onChange={(event) => setTyped(event.target.value)} aria-label="Filename confirmation" />
            </Field>
            <div className="row">
              <Button type="button" disabled={pending || typed !== expected} onClick={removePeople}>
                {pending ? 'Working' : 'Hide these people'}
              </Button>
              <Button type="button" secondary onClick={() => { if (!pending) setOpen(false); }}>Cancel</Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
