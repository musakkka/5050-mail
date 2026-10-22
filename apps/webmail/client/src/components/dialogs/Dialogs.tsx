import { useMemo, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useUi } from '../../state/ui';
import { useActions, useMail, useMailboxes } from '../../state/mail';
import { ShortcutsHelp } from '../keyboard/ShortcutsHelp';

export function Dialogs() {
  const dialog = useUi((s) => s.dialog);
  const close = useUi((s) => s.closeDialog);
  switch (dialog.kind) {
    case 'none':
      return null;
    case 'shortcuts':
      return <ShortcutsHelp onClose={close} />;
    case 'alert':
      return (
        <Dialog
          title={dialog.title}
          onClose={close}
          actions={
            <Button variant="text" onClick={close} data-autofocus>
              OK
            </Button>
          }
        >
          <p className="dialog__text">{dialog.body}</p>
        </Dialog>
      );
    case 'confirm':
      return (
        <Dialog
          title={dialog.title}
          onClose={close}
          actions={
            <>
              <Button variant="text" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="text"
                data-autofocus
                onClick={() => {
                  close();
                  dialog.onConfirm();
                }}
              >
                {dialog.confirmLabel}
              </Button>
            </>
          }
        >
          <p className="dialog__text">{dialog.body}</p>
        </Dialog>
      );
    case 'createLabel':
      return <LabelDialog parentId={dialog.parentId} onClose={close} />;
    case 'editLabel':
      return <LabelDialog mailboxId={dialog.mailboxId} onClose={close} />;
    case 'datetime':
      return <DateTimeDialog title={dialog.title} initial={dialog.initial} max={dialog.max} onPick={dialog.onPick} onClose={close} />;
  }
}

function LabelDialog({ mailboxId, parentId: initialParent, onClose }: { mailboxId?: string; parentId?: string; onClose: () => void }) {
  const { client } = useMail();
  const { data: model } = useMailboxes();
  const { invalidate } = useActions();
  const showSnack = useUi((s) => s.showSnack);
  const existing = mailboxId ? model?.byId.get(mailboxId) : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [nest, setNest] = useState(!!(existing?.parentId ?? initialParent));
  const [parentId, setParentId] = useState(existing?.parentId ?? initialParent ?? model?.labels[0]?.mailbox.id ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parents = useMemo(() => (model?.labels ?? []).filter((l) => l.mailbox.id !== mailboxId), [model, mailboxId]);

  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    if (n.includes('/')) return setErr('Label names can’t contain "/". Use "Nest label under" instead.');
    setBusy(true);
    try {
      const props = { name: n, parentId: nest && parentId ? parentId : null };
      const r = existing
        ? await client.mailboxSet({ update: { [existing.id]: props } })
        : await client.mailboxSet({ create: { l: { ...props, isSubscribed: true } } });
      const fail = Object.values({ ...(r.notCreated ?? {}), ...(r.notUpdated ?? {}) })[0];
      if (fail) throw new Error(fail.description ?? fail.type);
      invalidate([]);
      showSnack({ text: existing ? `Label "${n}" updated.` : `Label "${n}" created.` });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={existing ? 'Edit label' : 'New label'}
      onClose={onClose}
      className="dialog--legacy"
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="text" disabled={!name.trim() || busy} onClick={() => void submit()}>
            {existing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="field__label">{existing ? 'Label name' : 'Please enter a new label name:'}</span>
        <input
          className="field__input"
          value={name}
          maxLength={225}
          onChange={(e) => (setName(e.target.value), setErr(null))}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      </label>
      {parents.length ? (
        <>
          <label className="check-row">
            <input type="checkbox" checked={nest} onChange={(e) => setNest(e.target.checked)} />
            <span>Nest label under:</span>
          </label>
          <select className="field__select" disabled={!nest} value={parentId} onChange={(e) => setParentId(e.target.value)} aria-label="Parent label">
            {parents.map((l) => (
              <option key={l.mailbox.id} value={l.mailbox.id}>
                {l.path}
              </option>
            ))}
          </select>
        </>
      ) : null}
      {err ? <p className="field__error">{err}</p> : null}
    </Dialog>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Pick date & time (snooze / schedule): month grid + time field (02-components §13). */
function DateTimeDialog({
  title,
  initial,
  max,
  onPick,
  onClose,
}: {
  title: string;
  initial?: Date;
  max?: Date;
  onPick: (d: Date) => void;
  onClose: () => void;
}) {
  const start = initial ?? new Date();
  const [day, setDay] = useState(new Date(start.getFullYear(), start.getMonth(), start.getDate()));
  const [month, setMonth] = useState(new Date(start.getFullYear(), start.getMonth(), 1));
  const [time, setTime] = useState(`${pad(start.getHours())}:${pad(start.getMinutes())}`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cells: (Date | null)[] = [];
  for (let i = 0; i < month.getDay(); i++) cells.push(null);
  const daysIn = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  for (let d = 1; d <= daysIn; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d));
  const [h, m] = time.split(':').map(Number);
  const when = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h ?? 8, m ?? 0);
  const valid = when.getTime() > Date.now() && (!max || when <= max);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      className="dt-dialog"
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="text"
            disabled={!valid}
            onClick={() => {
              onClose();
              onPick(when);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="dt">
        <div className="dt__cal">
          <div className="dt__month">
            <button
              type="button"
              className="icon-btn"
              aria-label="Previous month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            >
              ‹
            </button>
            <span>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
            <button type="button" className="icon-btn" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
              ›
            </button>
          </div>
          <div className="dt__grid">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <span key={i} className="dt__dow">
                {d}
              </span>
            ))}
            {cells.map((c, i) =>
              c ? (
                <button
                  key={i}
                  type="button"
                  className={`dt__day${c.getTime() === day.getTime() ? ' dt__day--on' : ''}${c.getTime() === today.getTime() ? ' dt__day--today' : ''}`}
                  disabled={c < today || (!!max && c > max)}
                  onClick={() => setDay(c)}
                >
                  {c.getDate()}
                </button>
              ) : (
                <span key={i} />
              ),
            )}
          </div>
        </div>
        <div className="dt__fields">
          <label className="field">
            <span className="field__label">Date</span>
            <input className="field__input" readOnly value={day.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} />
          </label>
          <label className="field">
            <span className="field__label">Time</span>
            <input className="field__input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          {!valid ? <p className="field__error">{max && when > max ? 'Pick a time within the next 30 days.' : 'Pick a time in the future.'}</p> : null}
        </div>
      </div>
    </Dialog>
  );
}
