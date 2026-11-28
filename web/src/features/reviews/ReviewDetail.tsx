import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { Badge, Banner, Button, ConfirmDialog, PageHeader } from '../../components/ui';
import { COMPARE_FIELDS, fieldState, fieldText, signalLabels, type Person } from './reviewFields';

type Review = {
  conflict_id: string;
  status: string;
  confidence_score: string | number;
  signals_matched?: unknown;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  person_a: Person;
  person_b: Person;
};

const CLOSED_COPY: Record<string, string> = {
  confirmed: 'These records were merged.',
  rejected: 'These records were kept separate.',
  unmerged: 'A previous merge was reversed. These records are separate again.',
};

export function ReviewDetail() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<'confirm' | 'unmerge' | null>(null);
  const busy = useRef(false);
  const review = useQuery({
    queryKey: ['review', id],
    queryFn: () => api<Review>(`/v1/dashboard/reviews/${id}`),
  });

  async function decide(action: 'confirm' | 'reject' | 'unmerge') {
    if (busy.current) return;
    busy.current = true;
    setError('');
    setMessage('');
    setPending(true);
    try {
      await api(`/v1/dashboard/conflicts/${id}/${action}`, { method: 'POST', body: '{}' });
      const done = {
        confirm: 'These records were merged.',
        reject: 'These records were kept separate.',
        unmerge: 'A previous merge was reversed. These records are separate again.',
      };
      setMessage(done[action]);
      setDialog(null);
      await queryClient.invalidateQueries({ queryKey: ['review', id] });
      await queryClient.invalidateQueries({ queryKey: ['reviews'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That action could not be completed.');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (review.isLoading) return <p>Loading this review.</p>;
  if (review.isError || !review.data) return <Banner kind="error">This review could not be loaded.</Banner>;

  const data = review.data;
  const signals = signalLabels(data.signals_matched);
  return (
    <div className="stack">
      <PageHeader
        title="Review"
        lede={`The server recorded a score of ${data.confidence_score}. This screen does not calculate a new one.`}
      />
      <p><Link to="/reviews">Back to the queue</Link></p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Field</th><th>Existing record</th><th>New record</th><th></th></tr>
          </thead>
          <tbody>
            {COMPARE_FIELDS.map((field) => {
              const left = fieldText(data.person_a, field.key);
              const right = fieldText(data.person_b, field.key);
              const state = fieldState(left, right);
              return (
                <tr key={field.key} className={state === 'differ' ? 'differ' : undefined}>
                  <td>{field.label}</td>
                  <td>{left || 'Not stored'}</td>
                  <td>{right || 'Not stored'}</td>
                  <td>
                    {state === 'differ' ? <Badge kind="warn">Different</Badge> : null}
                    {state === 'match' ? <Badge kind="ok">Same</Badge> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {signals.length > 0 ? (
        <p>Signals the server recorded: {signals.join(', ')}.</p>
      ) : null}
      {data.reviewed_at ? (
        <p>
          Decision recorded {new Date(data.reviewed_at).toLocaleString()}
          {data.reviewed_by ? ` by ${data.reviewed_by}` : ''}.
        </p>
      ) : null}
      {data.status === 'pending' ? (
        <div className="row">
          <Button type="button" disabled={pending} onClick={() => setDialog('confirm')}>Confirm same person</Button>
          <Button type="button" secondary disabled={pending} onClick={() => decide('reject')}>Keep separate</Button>
        </div>
      ) : null}
      {data.status === 'confirmed' ? (
        <div className="stack">
          <Banner kind="ok">{CLOSED_COPY.confirmed}</Banner>
          <div className="row">
            <Button type="button" secondary disabled={pending} onClick={() => setDialog('unmerge')}>Undo merge</Button>
          </div>
        </div>
      ) : null}
      {data.status === 'rejected' ? <Banner kind="ok">{CLOSED_COPY.rejected}</Banner> : null}
      {data.status === 'unmerged' ? <Banner kind="ok">{CLOSED_COPY.unmerged}</Banner> : null}
      {message ? <Banner kind="ok">{message}</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
      {dialog === 'confirm' ? (
        <ConfirmDialog
          title="Merge these records?"
          body="The existing record keeps the identifiers. The new record is retired. This does not run a new match."
          confirmLabel="Merge"
          pending={pending}
          onConfirm={() => decide('confirm')}
          onCancel={() => { if (!pending) setDialog(null); }}
        />
      ) : null}
      {dialog === 'unmerge' ? (
        <ConfirmDialog
          title="Undo this merge?"
          body="The previously merged records will be separated again. Identifiers that moved go back to the retired record, and that record becomes active again."
          confirmLabel="Undo merge"
          pending={pending}
          onConfirm={() => decide('unmerge')}
          onCancel={() => { if (!pending) setDialog(null); }}
        />
      ) : null}
    </div>
  );
}
