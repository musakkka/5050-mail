import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useMail } from '../../state/mail';
import { useUi, emptyDraft } from '../../state/ui';
import { fetchConversation, type Conversation } from '../../mail/threads';
import { draftFromEmail, prefill, type ComposeDraft } from '../../mail/compose';
import { KW } from '../../mail/mapping';
import type { Email } from '../../jmap/types';

/** Open reply / reply-all / forward composers and saved drafts. */
export function useComposeOpeners() {
  const { client, myEmails, identities } = useMail();
  const qc = useQueryClient();
  const openComposer = useUi((s) => s.openComposer);
  const composers = useUi((s) => s.composers);
  const focusComposer = useUi((s) => s.focusComposer);

  const loadConversation = useCallback(
    (threadId: string) =>
      qc.fetchQuery({ queryKey: ['thread', threadId], queryFn: () => fetchConversation(client, threadId), staleTime: 15_000 }) as Promise<Conversation>,
    [qc, client],
  );

  const reply = useCallback(
    async (threadId: string, mode: 'reply' | 'replyAll' | 'forward', opts: { email?: Email; inline?: boolean } = {}) => {
      const conv = opts.email ? null : await loadConversation(threadId);
      const src = opts.email ?? [...(conv?.emails ?? [])].reverse().find((e) => !e.keywords[KW.draft]) ?? conv?.emails.at(-1);
      if (!src) return;
      const d: ComposeDraft = { ...emptyDraft(identities[0]?.id), ...prefill(mode, src, myEmails, identities) };
      openComposer(d, { inline: opts.inline });
    },
    [loadConversation, identities, myEmails, openComposer],
  );

  const openDraft = useCallback(
    async (threadId: string, emailId: string, opts: { inline?: boolean } = {}) => {
      const existing = composers.find((c) => c.draft.draftEmailId === emailId);
      if (existing) return focusComposer(existing.id);
      const conv = await loadConversation(threadId);
      const e = conv.emails.find((x) => x.id === emailId) ?? conv.emails.find((x) => x.keywords[KW.draft]);
      if (!e) return;
      // A reply draft inside a conversation reopens inline (03-behaviours §10).
      openComposer(draftFromEmail(e, identities), { inline: !!opts.inline && !!e.inReplyTo?.length });
    },
    [composers, focusComposer, loadConversation, openComposer, identities],
  );

  const compose = useCallback((patch: Partial<ComposeDraft> = {}) => openComposer({ ...emptyDraft(identities[0]?.id), ...patch }), [openComposer, identities]);

  return { reply, openDraft, compose, loadConversation };
}
