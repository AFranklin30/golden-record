export const FIELDS = ['first_name', 'last_name', 'email', 'birthday', 'zip', 'phone'] as const;
export type FieldName = typeof FIELDS[number];

export function headersFromCsv(text: string): string[] {
  const line = text.split(/\r?\n/).find((item) => item.trim() !== '');
  if (!line) return [];
  return line.split(',').map((header) => header.trim()).filter(Boolean);
}

export function suggestMapping(headers: string[]): Partial<Record<FieldName, string>> {
  const mapping: Partial<Record<FieldName, string>> = {};
  for (const field of FIELDS) {
    const match = headers.find((header) => header.toLowerCase().replace(/\s+/g, '_') === field);
    if (match) mapping[field] = match;
  }
  return mapping;
}
