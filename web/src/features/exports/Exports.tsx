import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { Banner, Button, PageHeader } from '../../components/ui';

type ImportSummary = { id: string; filename: string | null; created_at: string; row_count: number };

export function Exports() {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const history = useQuery({
    queryKey: ['imports'],
    queryFn: () => api<{ imports: ImportSummary[] }>('/v1/dashboard/imports'),
  });

  async function download() {
    setError('');
    setPending(true);
    try {
      const csv = await api<string>('/v1/dashboard/exports/fans');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'fans.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('The export could not be downloaded.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title="Exports"
        lede="This file is the current live people in the organization. Merged-away records are not their own rows."
      />
      <Button type="button" disabled={pending} onClick={download}>{pending ? 'Preparing export' : 'Download CSV'}</Button>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <h2>Import history</h2>
      {history.isLoading ? <p>Loading history.</p> : null}
      {history.isError ? <Banner kind="error">History could not be loaded.</Banner> : null}
      {history.data && history.data.imports.length === 0 ? <Banner kind="empty">No imports yet.</Banner> : null}
      {history.data && history.data.imports.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>File</th><th>Rows</th><th>When</th></tr></thead>
            <tbody>
              {history.data.imports.map((item) => (
                <tr key={item.id}>
                  <td>{item.filename || 'Untitled import'}</td>
                  <td>{item.row_count}</td>
                  <td>{new Date(item.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
