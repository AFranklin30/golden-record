import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { Banner, PageHeader } from '../../components/ui';
import { personLabel, reviewMatches, type Person } from './reviewFields';

type Review = {
  conflict_id: string;
  confidence_score: string | number;
  created_at?: string;
  person_a: Person;
  person_b: Person;
};

function peopleText(review: Review): string {
  return [personLabel(review.person_a), review.person_a.email?.join(' '), personLabel(review.person_b), review.person_b.email?.join(' ')].filter(Boolean).join(' ');
}

export function ReviewList() {
  const [query, setQuery] = useState('');
  const list = useQuery({
    queryKey: ['reviews'],
    queryFn: () => api<{ reviews: Review[] }>('/v1/dashboard/reviews'),
  });
  const reviews = useMemo(
    () => (list.data?.reviews || []).filter((review) => reviewMatches(peopleText(review), query)),
    [list.data, query],
  );

  if (list.isLoading) return <p>Loading reviews.</p>;
  if (list.isError || !list.data) return <Banner kind="error">Reviews could not be loaded. <button type="button" onClick={() => list.refetch()}>Try again</button></Banner>;

  return (
    <div className="stack">
      <PageHeader
        title="Review queue"
        lede="These pairs may be the same person. The score comes from the server. Nothing merges until you confirm."
      />
      <p className="lede">{list.data.reviews.length} pending in this list. The server returns the latest 100.</p>
      <label>
        Find in this list
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or email" />
      </label>
      {list.data.reviews.length === 0 ? <Banner kind="empty">No reviews are waiting.</Banner> : null}
      {list.data.reviews.length > 0 && reviews.length === 0 ? <Banner kind="empty">No loaded reviews match that name or email.</Banner> : null}
      {reviews.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>People</th><th>Server score</th><th>Opened</th><th>Action</th></tr>
            </thead>
            <tbody>
              {reviews.map((review) => (
                <tr key={review.conflict_id}>
                  <td>
                    <div className="person-name">{personLabel(review.person_a)}</div>
                    <div className="person-meta">{review.person_a.email?.[0] || 'No email'}</div>
                    <div className="person-name">{personLabel(review.person_b)}</div>
                    <div className="person-meta">{review.person_b.email?.[0] || 'No email'}</div>
                  </td>
                  <td>{review.confidence_score}</td>
                  <td>{review.created_at ? new Date(review.created_at).toLocaleString() : ''}</td>
                  <td><Link to={`/reviews/${review.conflict_id}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
