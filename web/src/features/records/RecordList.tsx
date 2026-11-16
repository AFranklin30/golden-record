import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { Badge, Banner, Button, PageHeader } from '../../components/ui';
import { personLabel, type Person } from '../reviews/reviewFields';

export type ImportedRecord = {
  import_row_id: string;
  batch_id: string;
  filename: string | null;
  row_number: number;
  status: string;
  fan_id: string | null;
  deleted_at: string | null;
  resolution_path: string | null;
  conflict_id: string | null;
  conflict_status: string | null;
  confidence_score: string | number | null;
  error: string | null;
  person: Person;
  review_opened: boolean;
};

type Page = {
  records: ImportedRecord[];
  total: number;
  limit: number;
  offset: number;
};

const PATHS = ['', 'A', 'B', 'C', 'D'] as const;

export function reviewNote(record: ImportedRecord): string {
  if (record.review_opened) return 'Review opened';
  return 'No review was opened';
}

export function RecordList() {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [path, setPath] = useState('');
  const [review, setReview] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (path) params.set('path', path);
  if (review) params.set('review', review);
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  const list = useQuery({
    queryKey: ['records', q, path, review, offset],
    queryFn: () => api<Page>(`/v1/dashboard/records?${params.toString()}`),
  });

  function onSearch(event: FormEvent) {
    event.preventDefault();
    setOffset(0);
    setQ(draft.trim());
  }

  if (list.isLoading) return <p>Loading imported records.</p>;
  if (list.isError || !list.data) {
    return <Banner kind="error">Imported records could not be loaded. <button type="button" onClick={() => list.refetch()}>Try again</button></Banner>;
  }

  const page = list.data;
  const shown = page.records.length;
  return (
    <div className="stack">
      <PageHeader
        title="Imported records"
        lede="People brought in from a file. No review was opened does not mean the person is unique."
      />
      <form className="row" onSubmit={onSearch}>
        <label>
          Search stored identifiers
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Name or email" />
        </label>
        <label>
          Path
          <select value={path} onChange={(event) => { setPath(event.target.value); setOffset(0); }}>
            {PATHS.map((item) => <option key={item || 'any'} value={item}>{item || 'Any path'}</option>)}
          </select>
        </label>
        <label>
          Review
          <select value={review} onChange={(event) => { setReview(event.target.value); setOffset(0); }}>
            <option value="">Any review state</option>
            <option value="queued">Review opened</option>
            <option value="none">No review was opened</option>
          </select>
        </label>
        <Button type="submit">Search</Button>
      </form>
      <p className="lede">{page.total} imported rows. Showing {shown === 0 ? 0 : offset + 1}–{offset + shown}.</p>
      {page.total === 0 ? <Banner kind="empty">No imported records match.</Banner> : null}
      {page.records.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Person</th><th>File</th><th>Path</th><th>Review</th><th>Server score</th><th></th></tr>
            </thead>
            <tbody>
              {page.records.map((record) => (
                <tr key={record.import_row_id}>
                  <td>
                    <div className="person-name">{record.person.name?.[0] || record.error || 'No stored name'}</div>
                    <div className="person-meta">{record.person.email?.[0] || (record.error ? '' : 'No email')}</div>
                  </td>
                  <td>{record.filename || 'Untitled import'} row {record.row_number}</td>
                  <td>{record.resolution_path || ''}</td>
                  <td>
                    <Badge kind={record.review_opened ? 'warn' : 'neutral'}>{reviewNote(record)}</Badge>
                  </td>
                  <td>{record.confidence_score ?? ''}</td>
                  <td><Link to={`/records/${record.import_row_id}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="row">
        <Button type="button" secondary disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</Button>
        <Button type="button" secondary disabled={offset + shown >= page.total} onClick={() => setOffset(offset + limit)}>Next</Button>
      </div>
    </div>
  );
}

export function recordHeading(record: ImportedRecord): string {
  return personLabel(record.person);
}
