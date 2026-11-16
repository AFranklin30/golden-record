export type Person = {
  name?: string[];
  email?: string[];
  dob?: string[];
  zip?: string[];
  phone?: string[];
};

export const COMPARE_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'dob', label: 'Birthday' },
  { key: 'zip', label: 'ZIP' },
  { key: 'phone', label: 'Phone' },
] as const;

const SIGNAL_LABELS: Record<string, string> = {
  email_similarity: 'Email',
  name_plus_dob: 'Name and birthday',
  name_plus_zip: 'Name and ZIP',
  guardian_email: 'Guardian email',
  device_id: 'Device',
  name_alone: 'Name',
};

export function fieldText(person: Person | undefined, key: string): string {
  const value = person?.[key as keyof Person];
  if (!Array.isArray(value)) return '';
  return value.filter(Boolean).join(', ');
}

export function fieldState(left: string, right: string): 'match' | 'differ' | 'one-sided' {
  if (!left || !right) return 'one-sided';
  return left === right ? 'match' : 'differ';
}

export function personLabel(person: Person | undefined): string {
  return fieldText(person, 'name') || fieldText(person, 'email') || 'Unnamed person';
}

export function reviewMatches(people: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return people.toLowerCase().includes(needle);
}

export function signalLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const key = typeof item === 'string'
      ? item
      : item && typeof item === 'object' && 'signal' in item && typeof item.signal === 'string'
        ? item.signal
        : '';
    if (!key) return [];
    return [SIGNAL_LABELS[key] || key];
  });
}
