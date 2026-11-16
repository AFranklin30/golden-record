import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { Badge, Banner, Button, ConfirmDialog, PageHeader } from '../../components/ui';
import { COMPARE_FIELDS, fieldText } from '../reviews/reviewFields';
import { recordHeading, reviewNote, type ImportedRecord } from './RecordList';

export function RecordDetail() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const busy = useRef(false);
  const detail = useQuery({
    queryKey: ['record', id],
    queryFn: () => api<{ record: ImportedRecord }>(`/v1/dashboard/records/${id}`),
  });

  async function hide() {
    if (busy.current || !detail.data) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      await api(`/v1/dashboard/fans/${detail.data.record.fan_id}/hide`, { method: 'POST', body: '{}' });
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: ['record', id] });
      await queryClient.invalidateQueries({ queryKey: ['records'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This person could not be hidden.');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (detail.isLoading) return <p>Loading this record.</p>;
  if (detail.isError || !detail.data) return <Banner kind="error">This record could not be loaded.</Banner>;

  const record = detail.data.record;
  return (
    <div className="stack">
      <PageHeader
        title={recordHeading(record)}
        lede={record.review_opened
          ? 'The server opened a review for this row. This screen does not calculate a score.'
          : 'No review was opened. That does not mean the person is unique.'}
      />
      <p><Link to="/records">Back to imported records</Link></p>
      <p>
        <Badge kind={record.review_opened ? 'warn' : 'neutral'}>{reviewNote(record)}</Badge>
        {record.resolution_path ? ` Path ${record.resolution_path}.` : ''}
        {record.confidence_score != null ? ` Server score ${record.confidence_score}.` : ''}
        {record.deleted_at ? ' This person is hidden from new matches and from the export.' : ''}
      </p>
      {record.error ? <Banner kind="error">{record.error}</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Field</th><th>Stored value</th></tr></thead>
          <tbody>
            {COMPARE_FIELDS.map((field) => (
              <tr key={field.key}>
                <td>{field.label}</td>
                <td>{fieldText(record.person, field.key) || 'Not stored'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>File: {record.filename || 'Untitled import'}, row {record.row_number}. <Link to={`/imports/${record.batch_id}`}>Open import</Link></p>
      {record.conflict_id ? <p><Link to={`/reviews/${record.conflict_id}`}>Open review</Link></p> : null}
      {record.fan_id && !record.deleted_at ? (
        <Button type="button" secondary onClick={() => setConfirming(true)}>Hide this person</Button>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title={`Hide ${recordHeading(record)}?`}
          body="This hides the person from new matches and from the export. The stored name and email stay in the database. Reviews and merge history stay."
          confirmLabel="Hide this person"
          pending={pending}
          onConfirm={hide}
          onCancel={() => { if (!pending) setConfirming(false); }}
        />
      ) : null}
    </div>
  );
}
