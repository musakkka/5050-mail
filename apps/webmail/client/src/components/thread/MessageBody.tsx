import { useEffect, useMemo, useRef, useState } from 'react';
import type { Email } from '../../jmap/types';
import { renderEmailHtml, textToHtml } from '../../mail/sanitize';
import { useMail } from '../../state/mail';

/** Pick the displayable body: HTML parts if present, else text → HTML. */
export function bodySource(e: Email): { html: string; isPlain: boolean } {
  const vals = e.bodyValues ?? {};
  const htmlParts = (e.htmlBody ?? []).filter((p) => p.partId && vals[p.partId]);
  if (htmlParts.some((p) => p.type === 'text/html')) {
    return {
      html: htmlParts.map((p) => (p.type === 'text/html' ? vals[p.partId!]!.value : textToHtml(vals[p.partId!]!.value))).join(''),
      isPlain: false,
    };
  }
  const textParts = (e.textBody ?? []).filter((p) => p.partId && vals[p.partId]);
  const text = (textParts.length ? textParts : htmlParts).map((p) => vals[p.partId!]!.value).join('\n');
  return { html: textToHtml(text || e.preview || ''), isPlain: true };
}

export function cidMapFor(e: Email, downloadUrl: (blobId: string, name: string, type: string) => string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of [...(e.attachments ?? []), ...(e.htmlBody ?? [])]) {
    if (p.cid && p.blobId) map[p.cid.replace(/^<|>$/g, '')] = downloadUrl(p.blobId, p.name ?? 'image', p.type);
  }
  return map;
}

/**
 * Renders sanitized email HTML in a sandboxed iframe (no allow-scripts).
 * allow-same-origin lets us size the frame to its content and lets cid: images
 * load from the same-origin download proxy; scripts can never run.
 */
export function MessageBody({
  email,
  allowRemote,
  dark,
  onBlockedChange,
}: {
  email: Email;
  allowRemote: boolean;
  dark: boolean;
  onBlockedChange?: (blocked: boolean) => void;
}) {
  const { client } = useMail();
  const [showQuote, setShowQuote] = useState(false);
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);

  const rendered = useMemo(() => {
    const { html } = bodySource(email);
    return renderEmailHtml(html, { allowRemote, dark, cidMap: cidMapFor(email, (b, n, t) => client.downloadUrl(b, n, t)) });
  }, [email, allowRemote, dark, client]);

  useEffect(() => onBlockedChange?.(rendered.blockedRemote), [rendered.blockedRemote, onBlockedChange]);

  const srcDoc = showQuote || !rendered.hasQuote ? rendered.full : rendered.trimmed;

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    let ro: ResizeObserver | undefined;
    const measure = () => {
      const doc = iframe.contentDocument;
      if (!doc?.documentElement) return;
      const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
      setHeight(Math.min(Math.max(h, 20), 200_000));
    };
    const onLoad = () => {
      measure();
      const doc = iframe.contentDocument;
      if (doc?.body && typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(measure);
        ro.observe(doc.body);
      }
      // Images load after `load` in some cases.
      doc?.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
    };
    iframe.addEventListener('load', onLoad);
    return () => {
      iframe.removeEventListener('load', onLoad);
      ro?.disconnect();
    };
  }, [srcDoc]);

  return (
    <div className={`msg-body${rendered.styled && dark ? ' msg-body--light-canvas' : ''}`}>
      <iframe
        ref={ref}
        className="msg-body__frame"
        title={`Message: ${email.subject ?? ''}`}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        style={{ height }}
      />
      {rendered.hasQuote ? (
        <button
          type="button"
          className="quote-toggle"
          aria-label={showQuote ? 'Hide trimmed content' : 'Show trimmed content'}
          data-tooltip={showQuote ? 'Hide trimmed content' : 'Show trimmed content'}
          aria-expanded={showQuote}
          onClick={() => setShowQuote(!showQuote)}
        >
          <span />
          <span />
          <span />
        </button>
      ) : null}
    </div>
  );
}
