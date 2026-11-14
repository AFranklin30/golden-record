import { useState } from 'react';
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
  person_a: Person;
  person_b: Person;
};

export function ReviewDetail() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const review = useQuery({
    queryKey: ['review', id],
    queryFn: () => api<Review>(`/v1/dashboard/reviews/${id}`),
  });

  async function decide(action: 'confirm' | 'reject') {
    setError('');
    setMessage('');
    setPending(true);
    try {
      await api(`/v1/dashboard/conflicts/${id}/${action}`, { method: 'POST', body: '{}' });
      setMessage(action === 'confirm' ? 'These records were merged.' : 'These records were kept separate.');
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: ['review', id] });
      await queryClient.invalidateQueries({ queryKey: ['reviews'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That action could not be completed.');
    } finally {
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
      {data.status === 'pending' ? (
        <div className="row">
          <Button type="button" disabled={pending} onClick={() => setConfirming(true)}>Confirm same person</Button>
          <Button type="button" secondary disabled={pending} onClick={() => decide('reject')}>Keep separate</Button>
        </div>
      ) : <Banner kind="ok">This review is {data.status}.</Banner>}
      {message ? <Banner kind="ok">{message}</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
      {confirming ? (
        <ConfirmDialog
          title="Merge these records?"
          body="The existing record keeps the identifiers. The new record is retired. This does not run a new match."
          confirmLabel="Merge"
          pending={pending}
          onConfirm={() => decide('confirm')}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
