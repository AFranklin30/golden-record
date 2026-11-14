import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';

export function Banner({ kind, children }: { kind: 'error' | 'ok' | 'empty'; children: ReactNode }) {
  return <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Button({
  children,
  secondary = false,
  ...props
}: { children: ReactNode; secondary?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={secondary ? 'secondary' : undefined} {...props}>{children}</button>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label>{label}{children}</label>;
}

export function PageHeader({ title, lede, children }: { title: string; lede?: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {children}
    </header>
  );
}

export function Badge({ kind = 'neutral', children }: { kind?: 'neutral' | 'ok' | 'warn' | 'danger'; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{title}</h2>
        <p>{body}</p>
        <div className="row">
          <Button type="button" disabled={pending} onClick={onConfirm}>{pending ? 'Working' : confirmLabel}</Button>
          <Button type="button" secondary onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
