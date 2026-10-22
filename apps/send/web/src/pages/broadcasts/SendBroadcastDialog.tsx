import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { broadcasts as broadcastsApi } from '@/api/client';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatNumber, fullDateTime } from '@/lib/format';
import { useTeamId } from '@/state/session';

type Mode = 'now' | 'datetime' | 'natural';

/** Parse "in 2 hours", "tomorrow 9am"-ish shortcuts locally for a confirmation preview (server re-parses). */
export function previewNatural(s: string, now = new Date()): Date | null {
  const t = s.trim().toLowerCase();
  const m = /^in\s+(\d+)\s*(minute|min|hour|hr|day|week)s?$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    const unit = { minute: 60e3, min: 60e3, hour: 3600e3, hr: 3600e3, day: 86400e3, week: 604800e3 }[m[2] as 'minute'];
    return new Date(now.getTime() + n * unit);
  }
  const tm = /^tomorrow(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/.exec(t);
  if (tm) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    let h = tm[1] ? Number(tm[1]) : 9;
    if (tm[3] === 'pm' && h < 12) h += 12;
    if (tm[3] === 'am' && h === 12) h = 0;
    d.setHours(h, tm[2] ? Number(tm[2]) : 0, 0, 0);
    return d;
  }
  return null;
}

export function SendBroadcastDialog({
  open,
  onOpenChange,
  broadcastId,
  segmentName,
  recipients,
  subject,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  broadcastId: string;
  segmentName?: string;
  recipients?: number;
  subject: string;
}) {
  const teamId = useTeamId();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('now');
  const [dt, setDt] = useState('');
  const [nl, setNl] = useState('in 1 hour');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setMode('now');
      setDt(format(new Date(Date.now() + 3600e3), "yyyy-MM-dd'T'HH:mm"));
      setNl('in 1 hour');
      setError(null);
    }
  }, [open]);

  const when = mode === 'datetime' ? (dt ? new Date(dt) : null) : mode === 'natural' ? previewNatural(nl) : null;
  const max = Date.now() + 30 * 86400e3;

  const submit = async () => {
    if (busy) return;
    setError(null);
    let scheduled: string | undefined;
    if (mode === 'datetime') {
      if (!when || Number.isNaN(when.getTime())) return setError('Pick a date and time.');
      if (when.getTime() <= Date.now()) return setError('Pick a time in the future.');
      if (when.getTime() > max) return setError('Broadcasts can be scheduled up to 30 days ahead.');
      scheduled = when.toISOString();
    } else if (mode === 'natural') {
      if (!nl.trim()) return setError('Describe when to send, e.g. “in 2 hours”.');
      scheduled = nl.trim();
    }
    setBusy(true);
    try {
      await broadcastsApi.send(teamId, broadcastId, scheduled);
      await qc.invalidateQueries({ queryKey: ['team', teamId, 'broadcasts'] });
      toast.success(scheduled ? 'Broadcast scheduled' : 'Broadcast is sending');
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  };

  const opt = (m: Mode, title: string, desc: string) => (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors',
        mode === m ? 'border-gray-8 bg-interactive' : 'border-interactive hover:bg-interactive',
      )}
    >
      <input type="radio" name="send-mode" className="mt-1 accent-[var(--gray-12)]" checked={mode === m} onChange={() => setMode(m)} />
      <span className="min-w-0">
        <span className="block text-sm text-emphasis">{title}</span>
        <span className="block text-xs text-muted">{desc}</span>
      </span>
    </label>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Send broadcast"
      description={
        <>
          <span className="break-words text-emphasis">“{subject || 'No subject'}”</span> goes to{' '}
          {recipients !== undefined ? (
            <span className="text-emphasis">
              {formatNumber(recipients)} subscribed contact{recipients === 1 ? '' : 's'}
            </span>
          ) : (
            'the subscribed contacts'
          )}
          {segmentName ? (
            <>
              {' '}
              in <span className="text-emphasis break-words">{segmentName}</span>
            </>
          ) : null}
          . This can't be undone once sending starts.
        </>
      }
      onSubmit={submit}
    >
      <fieldset className="mt-6 flex flex-col gap-2">
        <legend className="sr-only">When</legend>
        {opt('now', 'Send now', 'Start delivering immediately.')}
        {opt('datetime', 'Schedule', 'Pick a date and time (up to 30 days ahead).')}
        {mode === 'datetime' ? (
          <Input
            type="datetime-local"
            aria-label="Send at"
            value={dt}
            min={format(new Date(), "yyyy-MM-dd'T'HH:mm")}
            max={format(new Date(max), "yyyy-MM-dd'T'HH:mm")}
            onChange={(e) => setDt(e.target.value)}
            wrapperClassName="ml-7"
          />
        ) : null}
        {opt('natural', 'Schedule with natural language', 'For example “in 2 hours” or “tomorrow at 9am”.')}
        {mode === 'natural' ? <Input aria-label="Send when" value={nl} onChange={(e) => setNl(e.target.value)} wrapperClassName="ml-7" placeholder="in 2 hours" /> : null}
      </fieldset>
      {when && mode !== 'now' && !Number.isNaN(when.getTime()) ? <p className="mt-3 text-xs text-default">Sends {fullDateTime(when.toISOString())} (your time).</p> : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-error">
          {error}
        </p>
      ) : null}
      <DialogActions>
        <Button variant="primary" onClick={() => void submit()} loading={busy} kbd={['⌘', '↩︎']}>
          {mode === 'now' ? 'Send now' : 'Schedule'}
        </Button>
        <Button onClick={() => onOpenChange(false)} kbd={['Esc']}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}
