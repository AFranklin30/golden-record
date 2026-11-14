import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { Banner, PageHeader } from '../../components/ui';

type Detail = {
  import: { id: string; filename: string | null; created_at: string };
  rows: Array<{
    row_number: number;
    status: string;
    resolution_path: string | null;
    conflict_id: string | null;
    error: string | null;
  }>;
};

export function ImportDetail() {
  const { id = '' } = useParams();
  const detail = useQuery({
    queryKey: ['import', id],
    queryFn: () => api<Detail>(`/v1/dashboard/imports/${id}`),
  });

  if (detail.isLoading) return <p>Loading this import.</p>;
  if (detail.isError || !detail.data) return <Banner kind="error">This import could not be loaded.</Banner>;

  const rows = detail.data.rows;
  const errors = rows.filter((row) => row.status === 'error');
  return (
    <div className="stack">
      <PageHeader
        title={detail.data.import.filename || 'Import'}
        lede="Each row shows the path the server returned. A review link is a possible match, not a merge."
      />
      {rows.length === 0
        ? <Banner kind="empty">This import has no rows.</Banner>
        : <Banner kind={errors.length ? 'error' : 'ok'}>{rows.length - errors.length} stored. {errors.length} could not be stored. Nothing was merged automatically.</Banner>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Row</th><th>Status</th><th>Path</th><th>Review</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.row_number}>
                <td>{row.row_number}</td>
                <td>{row.error || row.status}</td>
                <td>{row.resolution_path || ''}</td>
                <td>{row.conflict_id ? <Link to={`/reviews/${row.conflict_id}`}>Open review</Link> : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
