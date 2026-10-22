/** Draft autosave, send (undo window), schedule send, discard — 05-jmap-mapping §7. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useMail, useMailboxes } from '../../state/mail';
import { useSettings } from '../../state/settings';
import { useUi, type Composer } from '../../state/ui';
import { buildEmail, envelopeFor, isDraftEmpty, isValidEmail, type ComposeAttachment, type ComposeDraft } from '../../mail/compose';
import { htmlToText } from '../../mail/sanitize';
import { KW } from '../../mail/mapping';
import type { Id } from '../../jmap/types';
import { formatShortDateTime } from '../../lib/format';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** Replace editor object-URLs of inline images with their cid: references. */
function withCids(d: ComposeDraft): ComposeDraft {
  let html = d.html;
  for (const a of d.attachments) if (a.cid && a.previewUrl) html = html.split(a.previewUrl).join(`cid:${a.cid}`);
  return { ...d, html };
}

export function useComposer(composer: Composer) {
  const { client, identities } = useMail();
  const { data: model } = useMailboxes();
  const qc = useQueryClient();
  const nav = useNavigate();
  const updateDraft = useUi((s) => s.updateDraft);
  const closeComposer = useUi((s) => s.closeComposer);
  const openComposer = useUi((s) => s.openComposer);
  const showSnack = useUi((s) => s.showSnack);
  const openDialog = useUi((s) => s.openDialog);
  const undoSeconds = useSettings((s) => s.undoSendSeconds);
  const setSettings = useSettings((s) => s.set);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const draftRef = useRef(composer.draft);
  draftRef.current = composer.draft;
  const saving = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const closed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const identity = identities.find((i) => i.id === composer.draft.identityId) ?? identities[0];
  const drafts = model?.roleId('drafts');

  const invalidateLists = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['threads'] });
    qc.invalidateQueries({ queryKey: ['mailboxes'] });
    if (draftRef.current.threadId) qc.invalidateQueries({ queryKey: ['thread', draftRef.current.threadId] });
  }, [qc]);

  /** Save the draft (create new + destroy old, since JMAP emails are immutable). */
  const save = useCallback(async (): Promise<Id | undefined> => {
    if (saving.current) await saving.current;
    const d = draftRef.current;
    if (!drafts || !dirty.current) return d.draftEmailId;
    if (isDraftEmpty(d) && !d.draftEmailId) return undefined;
    dirty.current = false;
    setStatus('saving');
    let newId: Id | undefined;
    const p = (async () => {
      const email = buildEmail(withCids(d), identity, { [drafts]: true }, { draft: true });
      const r = await client.emailSet({ create: { draft: email }, ...(d.draftEmailId ? { destroy: [d.draftEmailId] } : {}) });
      const created = r.created?.draft;
      if (!created) throw new Error(Object.values(r.notCreated ?? {})[0]?.description ?? 'Draft not saved');
      newId = created.id;
      if (!closed.current)
        updateDraft(composer.id, { draftEmailId: created.id, threadId: d.threadId ?? (created as unknown as { threadId?: string }).threadId });
      draftRef.current = { ...draftRef.current, draftEmailId: created.id };
    })();
    saving.current = p.then(
      () => undefined,
      () => undefined,
    );
    try {
      await p;
      setStatus('saved');
      invalidateLists();
      return newId;
    } catch {
      dirty.current = true;
      setStatus('error');
      return d.draftEmailId;
    } finally {
      saving.current = null;
    }
  }, [client, drafts, identity, composer.id, updateDraft, invalidateLists]);

  /** Mark changed; autosave 2s after the last change (03-behaviours §10). */
  const change = useCallback(
    (patch: Partial<ComposeDraft>) => {
      updateDraft(composer.id, patch);
      draftRef.current = { ...draftRef.current, ...patch };
      dirty.current = true;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), 2000);
    },
    [composer.id, updateDraft, save],
  );

  /** Update the draft without counting it as an edit (e.g. the automatic signature): no autosave. */
  const prefill = useCallback(
    (patch: Partial<ComposeDraft>) => {
      updateDraft(composer.id, patch);
      draftRef.current = { ...draftRef.current, ...patch };
    },
    [composer.id, updateDraft],
  );

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (status !== 'saved') return;
    const t = setTimeout(() => setStatus('idle'), 2500);
    return () => clearTimeout(t);
  }, [status]);

  // Save on page unload.
  useEffect(() => {
    const f = () => {
      if (dirty.current) void save();
    };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [save]);

  const close = useCallback(async () => {
    clearTimeout(timer.current);
    closed.current = true;
    closeComposer(composer.id);
    if (dirty.current) await save();
  }, [closeComposer, composer.id, save]);

  const discard = useCallback(async () => {
    clearTimeout(timer.current);
    closed.current = true;
    if (saving.current) await saving.current;
    const d = draftRef.current;
    closeComposer(composer.id);
    if (d.draftEmailId) {
      await client.emailSet({ destroy: [d.draftEmailId] }).catch(() => undefined);
      invalidateLists();
    }
    showSnack({
      text: 'Draft discarded.',
      actions: [
        {
          label: 'Undo',
          run: () => {
            openComposer({ ...d, draftEmailId: undefined }, { inline: composer.inline });
          },
        },
      ],
    });
  }, [client, closeComposer, composer.id, composer.inline, invalidateLists, openComposer, showSnack]);

  /** Validate, then send now (with undo window) or at `scheduleAt`. */
  const send = useCallback(
    async (scheduleAt?: Date) => {
      const d = draftRef.current;
      const all = [...d.to, ...d.cc, ...d.bcc];
      if (!all.length) return openDialog({ kind: 'alert', title: 'Error', body: 'Please specify at least one recipient.' });
      const bad = all.find((r) => !isValidEmail(r.email));
      if (bad)
        return openDialog({
          kind: 'alert',
          title: 'Error',
          body: `The address "${bad.email}" was not recognized. Please make sure that all addresses are properly formed.`,
        });
      if (d.attachments.some((a) => !a.blobId && !a.error))
        return openDialog({ kind: 'alert', body: 'Please wait until all attachments have finished uploading.' });
      if (!identity || !drafts || !model) return;
      const doSend = async () => {
        clearTimeout(timer.current);
        closed.current = true;
        if (saving.current) await saving.current;
        const cur = draftRef.current;
        const sent = model.roleId('sent');
        const scheduled = model.roleId('scheduled');
        const target = scheduleAt ? scheduled : sent;
        if (!target) return;
        closeComposer(composer.id);
        const sendingId = showSnack({ text: scheduleAt ? 'Scheduling…' : 'Sending…', duration: 0 });
        const hold = scheduleAt
          ? { HOLDUNTIL: scheduleAt.toISOString().replace(/\.\d{3}Z$/, 'Z') }
          : undoSeconds > 0
            ? { HOLDFOR: String(undoSeconds) }
            : undefined;
        try {
          const b = client.batch();
          const email = buildEmail(withCids(cur), identity, { [drafts]: true }, { draft: true });
          const create = b.call('Email/set', { create: { msg: email }, ...(cur.draftEmailId ? { destroy: [cur.draftEmailId] } : {}) });
          const sub = b.call('EmailSubmission/set', {
            create: { sub: { identityId: identity.id, emailId: '#msg', envelope: envelopeFor(cur, identity, hold) } },
            onSuccessUpdateEmail: { '#sub': { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${target}`]: true, [`keywords/${KW.draft}`]: null } },
          });
          if (cur.sourceEmailId)
            b.call('Email/set', { update: { [cur.sourceEmailId]: { [`keywords/${cur.mode === 'forward' ? KW.forwarded : KW.answered}`]: true } } });
          const r = await b.send();
          const created = r.get(create).created?.msg;
          if (!created) throw new Error(Object.values(r.get(create).notCreated ?? {})[0]?.description ?? 'Message could not be created');
          const subRes = r.get(sub);
          const submission = subRes.created?.sub;
          if (!submission) {
            // Keep it as a draft so nothing is lost.
            throw new Error(Object.values(subRes.notCreated ?? {})[0]?.description ?? 'Message could not be sent');
          }
          const threadId = (created as unknown as { threadId?: string }).threadId ?? cur.threadId;
          useUi.getState().hideSnack(sendingId);
          invalidateLists();
          const undo = async () => {
            try {
              await client.call('EmailSubmission/set', { update: { [submission.id]: { undoStatus: 'canceled' } } });
              await client.emailSet({
                update: { [created.id]: { [`mailboxIds/${target}`]: null, [`mailboxIds/${drafts}`]: true, [`keywords/${KW.draft}`]: true } },
              });
              openComposer({ ...cur, draftEmailId: created.id }, { inline: false });
              showSnack({ text: scheduleAt ? 'Scheduled send canceled.' : 'Sending undone.' });
            } catch (e) {
              showSnack({ text: `Couldn't undo: ${(e as Error).message}` });
            }
            invalidateLists();
          };
          if (scheduleAt) setSettings({ lastScheduledAt: scheduleAt.toISOString() });
          showSnack({
            text: scheduleAt ? `Send scheduled for ${formatShortDateTime(scheduleAt)}.` : 'Message sent.',
            duration: scheduleAt ? 10_000 : Math.max(undoSeconds, 5) * 1000,
            actions: [
              { label: 'Undo', run: undo },
              { label: 'View message', run: () => nav(`/mail/${scheduleAt ? 'scheduled' : 'sent'}/${threadId ?? ''}`) },
            ],
          });
        } catch (e) {
          useUi.getState().hideSnack(sendingId);
          showSnack({ text: `Couldn't send: ${(e as Error).message}` });
          openComposer({ ...cur }, { inline: composer.inline });
          invalidateLists();
        }
      };
      if (!d.subject.trim() && !htmlToText(d.html).trim()) {
        return openDialog({
          kind: 'confirm',
          title: 'Send message',
          body: 'Send this message without a subject or text in the body?',
          confirmLabel: 'OK',
          onConfirm: () => void doSend(),
        });
      }
      if (/\battach(ed|ment|ments|ing)\b/i.test(htmlToText(d.html)) && !d.attachments.length) {
        return openDialog({
          kind: 'confirm',
          title: 'Did you mean to attach files?',
          body: 'You wrote "attached" in your message, but there are no files attached. Send anyway?',
          confirmLabel: 'Send',
          onConfirm: () => void doSend(),
        });
      }
      await doSend();
    },
    [
      identity,
      drafts,
      model,
      client,
      closeComposer,
      composer.id,
      composer.inline,
      showSnack,
      openDialog,
      undoSeconds,
      invalidateLists,
      openComposer,
      nav,
      setSettings,
    ],
  );

  /** Upload files as attachments (or inline images). */
  const attach = useCallback(
    (files: File[], inline = false) => {
      const max = client.limits?.maxSizeUpload ?? 50_000_000;
      const added: ComposeAttachment[] = files.map((f, i) => ({
        key: `up${Date.now()}${i}`,
        name: f.name,
        type: f.type || 'application/octet-stream',
        size: f.size,
        progress: 0,
        ...(inline ? { cid: `img${Date.now()}${i}@acme`, previewUrl: URL.createObjectURL(f) } : {}),
        ...(f.size > max ? { error: `Larger than ${Math.round(max / 1e6)} MB` } : {}),
      }));
      change({ attachments: [...draftRef.current.attachments, ...added] });
      added.forEach((a, i) => {
        if (a.error) return;
        const setA = (patch: Partial<ComposeAttachment>) =>
          change({ attachments: draftRef.current.attachments.map((x) => (x.key === a.key ? { ...x, ...patch } : x)) });
        client
          .upload(files[i]!, client.accountId, (p) => setA({ progress: p }))
          .then((r) => setA({ blobId: r.blobId, progress: 1, type: a.type || r.type }))
          .catch((e) => setA({ error: (e as Error).message }));
      });
      return added;
    },
    [client, change],
  );

  /** Shift+click "Full screen": continue this draft in a separate browser window. */
  const popOut = useCallback(async () => {
    dirty.current = true;
    const id = await save();
    if (!id) return;
    window.open(`/mail/drafts?compose=${encodeURIComponent(id)}`, '_blank', 'width=640,height=600');
    closed.current = true;
    closeComposer(composer.id);
  }, [save, closeComposer, composer.id]);

  return { status, change, prefill, save, close, discard, send, attach, identity, popOut };
}
