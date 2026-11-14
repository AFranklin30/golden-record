import { describe, expect, test } from 'vitest';
import { fieldState, reviewMatches, signalLabels } from './reviewFields';

describe('review fields', () => {
  test('a field on both sides is marked only when the text differs', () => {
    expect(fieldState('Ada Lovelace', 'Ada Lovelace')).toBe('match');
    expect(fieldState('Ada Lovelace', 'A. Lovelace')).toBe('differ');
    expect(fieldState('', 'Ada Lovelace')).toBe('one-sided');
  });

  test('the queue filter uses the loaded names and emails', () => {
    expect(reviewMatches('Ada Lovelace ada@example.com', 'ada@')).toBe(true);
    expect(reviewMatches('Ada Lovelace ada@example.com', 'bob')).toBe(false);
    expect(reviewMatches('Ada Lovelace', '  ')).toBe(true);
  });

  test('signal names are the labels the server stored', () => {
    expect(signalLabels([{ signal: 'name_plus_dob', adjusted_score: 0.7 }])).toEqual(['Name and birthday']);
    expect(signalLabels('email_similarity')).toEqual([]);
  });
});
