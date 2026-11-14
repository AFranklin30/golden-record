import { describe, expect, it } from 'vitest';
import { headersFromCsv, suggestMapping } from './mapping';

describe('column mapping', () => {
  it('suggests a mapping when the file already uses the expected names', () => {
    const headers = headersFromCsv('first_name,last_name,email\nAda,Lovelace,ada@example.com\n');
    expect(suggestMapping(headers)).toEqual({
      first_name: 'first_name',
      last_name: 'last_name',
      email: 'email',
    });
  });

  it('matches a header that differs only by spaces and case', () => {
    expect(suggestMapping(['First Name', 'Email'])).toEqual({
      first_name: 'First Name',
      email: 'Email',
    });
  });
});
