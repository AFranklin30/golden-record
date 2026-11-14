import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { Banner, PageHeader } from '../../components/ui';

type ImportSummary = { id: string; filename: string | null; created_at: string; row_count: number; error_count: number };

export function ImportList() {
  const list = useQuery({
    queryKey: ['imports'],
    queryFn: () => api<{ imports: ImportSummary[] }>('/v1/dashboard/imports'),
  });

  if (list.isLoading) return <p>Loading imports.</p>;
  if (list.isError || !list.data) return <Banner kind="error">Imports could not be loaded. <button type="button" onClick={() => list.refetch()}>Try again</button></Banner>;

  return (
    <div className="stack">
      <PageHeader title="Imports" lede="Files already brought into this organization.">
        <Link className="button" to="/imports/new">New import</Link>
      </PageHeader>
      {list.data.imports.length === 0
        ? <Banner kind="empty">No imports yet.</Banner>
        : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>File</th><th>Rows</th><th>Errors</th><th>When</th></tr>
              </thead>
              <tbody>
                {list.data.imports.map((item) => (
                  <tr key={item.id}>
                    <td><Link to={`/imports/${item.id}`}>{item.filename || 'Untitled import'}</Link></td>
                    <td>{item.row_count}</td>
                    <td>{item.error_count}</td>
                    <td>{new Date(item.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
