import { useEffect, useRef, useState, type DragEvent } from 'react';
import { CloudUpload, FileText, X } from 'lucide-react';
import { contacts as contactsApi, segments as segmentsApi } from '@/api/client';
import { useTeamQuery } from '@/api/hooks';
import { ApiError } from '@/api/http';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { toast } from '@/components/ui/toast';
import { contactsFromCsv, type ParsedContact } from '@/lib/csv';
import { formatBytes, formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useTeamId } from '@/state/session';
import { importContacts } from './importApi';
import { useInvalidateAudience } from './shared';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function useSegmentOptions() {
  const segs = useTeamQuery(['segments'], (t) => segmentsApi.list(t));
  return [{ value: 'none', label: 'No segment' }, ...(segs.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))];
}

export function parseEmailList(text: string): { valid: string[]; invalid: string[] } {
  const parts = text
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^<|>$/g, '').toLowerCase())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) (EMAIL_RE.test(p) ? valid : invalid).push(p);
  return { valid: [...new Set(valid)], invalid };
}

/** "Add manually": one or many addresses, optional name (single address), segment, subscription. */
export function AddContactDialog({ open, onOpenChange, defaultSegment }: { open: boolean; onOpenChange: (o: boolean) => void; defaultSegment?: string | null }) {
  const teamId = useTeamId();
  const invalidate = useInvalidateAudience();
  const segOptions = useSegmentOptions();
  const [emails, setEmails] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [segment, setSegment] = useState('none');
  const [subscribed, setSubscribed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setEmails('');
      setFirst('');
      setLast('');
      setSegment(defaultSegment ?? 'none');
      setSubscribed(true);
      setError(null);
    }
  }, [open, defaultSegment]);
  const parsed = parseEmailList(emails);
  const single = parsed.valid.length <= 1;

  const submit = async () => {
    if (busy) return;
    if (!parsed.valid.length) {
      setError('Enter at least one valid email address.');
      return;
    }
    if (parsed.invalid.length) {
      setError(`Not valid: ${parsed.invalid.slice(0, 3).join(', ')}${parsed.invalid.length > 3 ? '…' : ''}`);
      return;
    }
    setBusy(true);
    setError(null);
    let ok = 0;
    const failed: string[] = [];
    for (const email of parsed.valid) {
      try {
        await contactsApi.create(teamId, {
          email,
          ...(single && first.trim() ? { first_name: first.trim() } : {}),
          ...(single && last.trim() ? { last_name: last.trim() } : {}),
          unsubscribed: !subscribed,
          ...(segment !== 'none' ? { segments: [segment] } : {}),
        });
        ok++;
      } catch (e) {
        failed.push(`${email}: ${e instanceof ApiError ? e.message : 'failed'}`);
      }
    }
    await invalidate();
    setBusy(false);
    if (failed.length && !ok) {
      setError(failed.slice(0, 3).join(' · '));
      return;
    }
    toast.success(ok === 1 ? 'Contact added' : `${formatNumber(ok)} contacts added`, failed.length ? { description: `${failed.length} could not be added` } : undefined);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add contacts" onSubmit={submit}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Email addresses" htmlFor="contact-emails" hint="Separate multiple addresses with commas or new lines." error={error}>
          <Textarea
            id="contact-emails"
            autoFocus
            rows={3}
            placeholder="steve.wozniak@example.com"
            value={emails}
            invalid={!!error}
            onChange={(e) => setEmails(e.target.value)}
            className="font-mono text-[13px]"
          />
        </Field>
        {single ? (
          <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
            <Field label="First name" htmlFor="contact-first">
              <Input id="contact-first" placeholder="Steve" value={first} onChange={(e) => setFirst(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Last name" htmlFor="contact-last">
              <Input id="contact-last" placeholder="Wozniak" value={last} onChange={(e) => setLast(e.target.value)} autoComplete="off" />
            </Field>
          </div>
        ) : null}
        <Field label="Segment" htmlFor="contact-segment">
          <Select id="contact-segment" value={segment} onChange={setSegment} options={segOptions} />
        </Field>
        <div className="mt-6 flex items-center justify-between gap-4 rounded-xl border border-interactive bg-interactive px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm text-emphasis">Subscribed</p>
            <p className="text-xs text-muted">Unsubscribed contacts don't receive broadcasts.</p>
          </div>
          <Switch checked={subscribed} onChange={setSubscribed} label="Subscribed" />
        </div>
        <DialogActions>
          <Button type="submit" variant="primary" loading={busy} disabled={!emails.trim()} kbd={['⌘', '↩︎']}>
            Add
          </Button>
          <Button onClick={() => onOpenChange(false)} kbd={['Esc']}>
            Cancel
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** "Import CSV": drop or pick a file, preview valid/invalid rows, optional segment, then import. */
export function ImportContactsDialog({ open, onOpenChange, initialFile }: { open: boolean; onOpenChange: (o: boolean) => void; initialFile?: File | null }) {
  const teamId = useTeamId();
  const invalidate = useInvalidateAudience();
  const segOptions = useSegmentOptions();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ParsedContact[]>([]);
  const [invalid, setInvalid] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useState('none');
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  const load = async (f: File) => {
    setError(null);
    setFile(f);
    if (f.size > 50 * 1024 * 1024) {
      setRows([]);
      setError('The file is larger than 50 MB.');
      return;
    }
    if (!/\.(csv|txt)$/i.test(f.name) && !/csv|text/.test(f.type)) {
      setRows([]);
      setError('Choose a .csv file.');
      return;
    }
    const r = contactsFromCsv(await f.text());
    setRows(r.contacts);
    setInvalid(r.invalid);
    if (r.error) setError(r.error);
    else if (!r.contacts.length) setError('No valid email addresses found in the file.');
  };

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setRows([]);
    setInvalid(0);
    setError(null);
    setSegment('none');
    setProgress('');
    if (initialFile) void load(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile]);

  const submit = async () => {
    if (!rows.length || busy) return;
    setBusy(true);
    try {
      const r = await importContacts(teamId, rows, segment === 'none' ? null : segment, setProgress);
      await invalidate();
      toast.success(`Imported ${formatNumber(r.imported + r.updated)} contact${r.imported + r.updated === 1 ? '' : 's'}`, {
        description: [r.updated ? `${r.updated} updated` : '', r.skipped ? `${r.skipped} skipped` : '', r.failed ? `${r.failed} failed` : ''].filter(Boolean).join(' · ') || undefined,
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void load(f);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Import contacts" onSubmit={submit}>
      <p className="mt-2 text-sm text-default">
        Upload a CSV with an <code className="font-mono text-[13px] text-emphasis">email</code> column. Optional columns: <code className="font-mono text-[13px] text-emphasis">first_name</code>,{' '}
        <code className="font-mono text-[13px] text-emphasis">last_name</code>, <code className="font-mono text-[13px] text-emphasis">unsubscribed</code>.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="text/csv,.csv"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void load(f);
          e.target.value = '';
        }}
      />
      {file ? (
        <div className="mt-6 flex items-center gap-3 rounded-2xl border border-interactive bg-interactive px-3 py-3">
          <FileText size={20} className="shrink-0 text-default" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-emphasis" title={file.name}>
              {file.name}
            </p>
            <p className="text-xs text-muted">
              {formatBytes(file.size)} · {formatNumber(rows.length)} contact{rows.length === 1 ? '' : 's'}
              {invalid ? ` · ${formatNumber(invalid)} invalid or duplicate row${invalid === 1 ? '' : 's'} skipped` : ''}
            </p>
          </div>
          <button
            type="button"
            aria-label="Remove file"
            onClick={() => {
              setFile(null);
              setRows([]);
              setError(null);
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded-lg text-default hover:bg-interactive-hover"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          className={cn(
            'mt-6 flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-6 py-10 text-center transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-focus',
            drag ? 'border-gray-8 bg-interactive-hover' : 'border-interactive bg-interactive hover:bg-interactive-hover',
          )}
        >
          <CloudUpload size={22} className="text-default" />
          <span className="text-sm text-emphasis">Drop a CSV file here, or click to browse</span>
          <span className="text-xs text-muted">Up to 50 MB</span>
        </button>
      )}
      {rows.length ? (
        <div className="mt-4 max-h-40 overflow-auto rounded-xl border border-gray-3">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-background text-default">
              <tr>
                <th className="px-3 py-1.5 font-semibold">Email</th>
                <th className="px-3 py-1.5 font-semibold">Name</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 5).map((r) => (
                <tr key={r.email} className="border-t border-gray-2">
                  <td className="max-w-[16rem] truncate px-3 py-1.5 text-emphasis">{r.email}</td>
                  <td className="max-w-[10rem] truncate px-3 py-1.5 text-default">{[r.first_name, r.last_name].filter(Boolean).join(' ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 5 ? <p className="border-t border-gray-2 px-3 py-1.5 text-xs text-muted">and {formatNumber(rows.length - 5)} more…</p> : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-error">
          {error}
        </p>
      ) : null}
      <Field label="Add to segment (optional)" htmlFor="import-segment">
        <Select id="import-segment" value={segment} onChange={setSegment} options={segOptions} />
      </Field>
      <DialogActions>
        <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!rows.length} kbd={['⌘', '↩︎']}>
          {busy ? progress || 'Importing…' : rows.length ? `Import ${formatNumber(rows.length)}` : 'Import'}
        </Button>
        <Button onClick={() => onOpenChange(false)} kbd={['Esc']}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}
