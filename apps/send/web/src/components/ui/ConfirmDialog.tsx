import { useState, type ReactNode } from 'react';
import { Dialog, DialogActions } from './Dialog';
import { Button } from './Button';
import { Input } from './Input';

/**
 * Destructive confirmation (⌘↩ confirms, Esc cancels). With `typeToConfirm`, the
 * user must type that text first (used for deleting domains and keys).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  onConfirm,
  loading,
  typeToConfirm,
  danger = true,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
  typeToConfirm?: string;
  danger?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const ok = !typeToConfirm || typed.trim() === typeToConfirm;
  const run = () => {
    if (ok && !loading) void onConfirm();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped('');
        onOpenChange(o);
      }}
      title={title}
      description={description}
      onSubmit={run}
      size="sm"
    >
      {typeToConfirm ? (
        <div className="mt-6 flex flex-col gap-2">
          <label htmlFor="confirm-text" className="text-sm text-default">
            Type <span className="font-mono text-emphasis break-all">{typeToConfirm}</span> to confirm
          </label>
          <Input id="confirm-text" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </div>
      ) : null}
      <DialogActions>
        <Button variant={danger ? 'danger' : 'primary'} kbd={['⌘', '↩︎']} onClick={run} disabled={!ok} loading={loading}>
          {confirmLabel}
        </Button>
        <Button kbd={['Esc']} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}
