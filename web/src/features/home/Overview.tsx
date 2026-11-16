import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { Banner, PageHeader } from '../../components/ui';

type Review = { conflict_id: string };
type ImportSummary = { id: string; filename: string | null; created_at: string; row_count: number; error_count: number };

export function Overview() {
  const reviews = useQuery({
    queryKey: ['reviews'],
    queryFn: () => api<{ reviews: Review[] }>('/v1/dashboard/reviews'),
  });
  const imports = useQuery({
    queryKey: ['imports'],
    queryFn: () => api<{ imports: ImportSummary[] }>('/v1/dashboard/imports'),
  });
  const recent = imports.data?.imports.slice(0, 5) || [];

  return (
    <div className="stack">
      <PageHeader
        title="Overview"
        lede="What is waiting in this organization, and the latest files that were imported."
      />
      <div className="stat-row">
        <section className="panel stack">
          <h2>Pending reviews</h2>
          {reviews.isLoading ? <p>Loading reviews.</p> : null}
          {reviews.isError ? <Banner kind="error">Reviews could not be loaded. <button type="button" onClick={() => reviews.refetch()}>Try again</button></Banner> : null}
          {reviews.data ? <p className="stat">{reviews.data.reviews.length}</p> : null}
          {reviews.data && reviews.data.reviews.length === 100 ? <p className="lede">The queue returns the latest 100.</p> : null}
          <Link to="/reviews">Open the review queue</Link>
        </section>
        <section className="panel stack">
          <h2>Next import</h2>
          <p>Upload a customer file, check the rows, then import. Nothing merges on its own.</p>
          <Link className="button" to="/imports/new">New import</Link>
        </section>
      </div>
      <section className="stack">
        <h2>Recent imports</h2>
        {imports.isLoading ? <p>Loading imports.</p> : null}
        {imports.isError ? <Banner kind="error">Imports could not be loaded. <button type="button" onClick={() => imports.refetch()}>Try again</button></Banner> : null}
        {imports.data && recent.length === 0 ? <Banner kind="empty">No imports yet. <Link to="/imports/new">Import a file</Link></Banner> : null}
        {recent.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>File</th><th>Rows</th><th>Errors</th><th>When</th></tr></thead>
              <tbody>
                {recent.map((item) => (
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
        ) : null}
      </section>
    </div>
  );
}
