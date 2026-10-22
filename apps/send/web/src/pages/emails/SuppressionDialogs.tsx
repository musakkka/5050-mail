import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { suppressions as api } from '@/api/client';
import { useTeamMutation } from '@/api/hooks';
import type { Suppression } from '@/api/types';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field, Textarea } from '@/components/ui/Input';
import { toast, toastError } from '@/components/ui/toast';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "Add manually": one or more addresses (comma, space or newline separated). */
export function AddSuppressionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setText('');
      setError(null);
    }
  }, [open]);
  const add = useTeamMutation(
    async (t, emails: string[]) => {
      const failed: string[] = [];
      for (const e of emails) {
        try {
          await api.add(t, e);
        } catch (err) {
          failed.push(`${e}: ${(err as Error).message}`);
        }
      }
      return { added: emails.length - failed.length, failed };
    },
    [['suppressions']],
    {
      silent: true,
      onSuccess: (r) => {
        if (r.failed.length && !r.added) {
          setError(r.failed[0]!);
          return;
        }
        toast.success(`Suppressed ${r.added} email address${r.added === 1 ? '' : 'es'}`);
        if (r.failed.length) toast.error(`${r.failed.length} could not be added`);
        onOpenChange(false);
      },
    },
  );
  const emails = [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const invalid = emails.filter((e) => !EMAIL.test(e));
  const submit = () => {
    if (!emails.length) return setError('Enter at least one email address.');
    if (invalid.length) return setError(`Invalid email address: ${invalid[0]}`);
    setError(null);
    add.mutate(emails);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add email address" onSubmit={submit}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Email addresses" htmlFor="supp-emails" error={error} hint="Separate multiple addresses with commas or new lines. Suppressed addresses are skipped when sending.">
          <Textarea
            id="supp-emails"
            autoFocus
            rows={4}
            placeholder="name@example.com"
            value={text}
            invalid={!!error}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <DialogActions>
          <Button type="submit" variant="primary" kbd={['⌘', '↩︎']} loading={add.isPending} disabled={!emails.length}>
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

export function ConfirmRemoveDialog({ items, onClose, onDone, teamId }: { items: Suppression[] | null; onClose: () => void; onDone?: () => void; teamId: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const n = items?.length ?? 0;
  const run = async () => {
    if (!items) return;
    setBusy(true);
    try {
      for (const s of items) await api.remove(teamId, s.id);
      toast.success(n === 1 ? `${items[0]!.email} can receive emails again` : `Removed ${n} suppressions`);
      await qc.invalidateQueries({ queryKey: ['team', teamId, 'suppressions'] });
      onDone?.();
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!items}
      onOpenChange={(o) => !o && onClose()}
      title={n === 1 ? 'Remove suppression' : `Remove ${n} suppressions`}
      description={
        n === 1 ? (
          <>
            Emails to <span className="text-emphasis break-all">{items![0]!.email}</span> will be sent again. Only do this if you're sure the address is valid and wants your email.
          </>
        ) : (
          'These addresses will receive emails again. Only do this if you are sure they are valid.'
        )
      }
      onSubmit={run}
    >
      <DialogActions>
        <Button variant="danger" kbd={['⌘', '↩︎']} loading={busy} onClick={run}>
          Remove
        </Button>
        <Button onClick={onClose} kbd={['Esc']}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}
