import { FormEvent, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Banner, Button, Field, PageHeader } from '../../components/ui';
import { FIELDS, headersFromCsv, suggestMapping, type FieldName } from './mapping';
import { PreviewTable, type PreviewRow } from './PreviewTable';

const LABELS: Record<FieldName, string> = {
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  birthday: 'Birthday',
  zip: 'ZIP',
  phone: 'Phone',
};

export function ImportNew() {
  const navigate = useNavigate();
  const [filename, setFilename] = useState('');
  const [csv, setCsv] = useState('');
  const [mapping, setMapping] = useState<Partial<Record<FieldName, string>>>({});
  const [preview, setPreview] = useState<{ preview: PreviewRow[]; error_count: number } | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const headers = useMemo(() => headersFromCsv(csv), [csv]);

  function onFile(file: File) {
    setFilename(file.name);
    file.text().then((text) => {
      setCsv(text);
      setMapping(suggestMapping(headersFromCsv(text)));
      setPreview(null);
    }).catch(() => setError('That file could not be read.'));
  }

  async function onPreview(event: FormEvent) {
    event.preventDefault();
    setError('');
    setPending(true);
    try {
      const result = await api<{ preview: PreviewRow[]; error_count: number }>('/v1/dashboard/imports/preview', {
        method: 'POST',
        body: JSON.stringify({ csv, mapping }),
      });
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed.');
    } finally {
      setPending(false);
    }
  }

  async function onImport() {
    setError('');
    setPending(true);
    try {
      const result = await api<{ batch_id: string }>('/v1/dashboard/imports', {
        method: 'POST',
        body: JSON.stringify({ csv, mapping, filename }),
      });
      navigate(`/imports/${result.batch_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack" onSubmit={onPreview}>
      <PageHeader title="New import" lede="Upload a file, map the columns, preview the rows, then import. A preview writes nothing." />
      <ol className="steps">
        <li className={csv ? 'done' : 'current'}>Upload</li>
        <li className={preview ? 'done' : csv ? 'current' : undefined}>Map columns</li>
        <li className={preview ? 'current' : undefined}>Preview and import</li>
      </ol>
      <Field label="Customer file">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onFile(file);
          }}
        />
      </Field>
      {headers.length > 0 ? (
        <div className="row">
          {FIELDS.map((field) => (
            <Field key={field} label={LABELS[field]}>
              <select
                value={mapping[field] || ''}
                onChange={(event) => setMapping({ ...mapping, [field]: event.target.value })}
              >
                <option value="">Not in this file</option>
                {headers.map((header) => <option key={header} value={header}>{header}</option>)}
              </select>
            </Field>
          ))}
        </div>
      ) : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
      <div className="row">
        <Button type="submit" disabled={pending || csv === ''}>{pending ? 'Working' : 'Preview'}</Button>
        <Button type="button" secondary disabled={pending || !preview} onClick={onImport}>Import</Button>
      </div>
      {preview ? <PreviewTable rows={preview.preview} errorCount={preview.error_count} /> : null}
    </form>
  );
}
