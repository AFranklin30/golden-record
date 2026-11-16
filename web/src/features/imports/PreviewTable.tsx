import { Banner } from '../../components/ui';

export type PreviewRow = {
  row_number: number;
  status: 'ok' | 'error';
  error: string | null;
  values: Record<string, string>;
};

export function PreviewTable({ rows, errorCount }: { rows: PreviewRow[]; errorCount: number }) {
  if (rows.length === 0) {
    return <Banner kind="empty">No data rows to preview.</Banner>;
  }
  return (
    <div className="stack">
      {errorCount > 0
        ? <Banner kind="error">{errorCount} {errorCount === 1 ? 'row needs' : 'rows need'} an email, or a name and a birthday, before import.</Banner>
        : <Banner kind="ok">Every previewed row can be imported.</Banner>}
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Import preview</caption>
          <thead>
            <tr>
              <th>Row</th>
              <th>Name</th>
              <th>Email</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.row_number}>
                <td>{row.row_number}</td>
                <td>{[row.values.first_name, row.values.last_name].filter(Boolean).join(' ')}</td>
                <td>{row.values.email}</td>
                <td>{row.status === 'error' ? row.error : 'Ready'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
