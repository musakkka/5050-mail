import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useModal } from '../ui/useModal';
import { createPortal } from 'react-dom';
import { IconButton } from '../ui/Button';
import { Icon } from '../icons/Icon';
import { useMail } from '../../state/mail';
import type { EmailBodyPart } from '../../jmap/types';
import { attachmentIcon, isPreviewable } from './attachmentIcon';
import { formatSize } from '../../lib/format';

type Att = Pick<EmailBodyPart, 'blobId' | 'name' | 'type' | 'size'>;

export function useAttachmentPreview(): { open: (a: Att, all?: Att[]) => void; element: ReactNode } {
  const [state, setState] = useState<{ list: Att[]; index: number } | null>(null);
  const open = useCallback((a: Att, all?: Att[]) => {
    const list = (all ?? [a]).filter((x) => x.blobId);
    const index = Math.max(
      0,
      list.findIndex((x) => x.blobId === a.blobId),
    );
    setState({ list: list.length ? list : [a], index });
  }, []);
  const element = state ? (
    <AttachmentPreview list={state.list} index={state.index} onIndex={(i) => setState({ ...state, index: i })} onClose={() => setState(null)} />
  ) : null;
  return { open, element };
}

function AttachmentPreview({ list, index, onIndex, onClose }: { list: Att[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const { client } = useMail();
  const a = list[index]!;
  const name = a.name ?? 'attachment';
  const type = a.type || 'application/octet-stream';
  const downloadUrl = client.downloadUrl(a.blobId!, name, type);
  const inlineUrl = client.downloadUrl(a.blobId!, name, type, { inline: true });
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    if (!/^text\//.test(type)) return;
    let alive = true;
    client
      .downloadBlob(a.blobId!, name, type)
      .then((b) => b.text())
      .then((t) => alive && setText(t.slice(0, 200_000)))
      .catch(() => alive && setText('Preview unavailable.'));
    return () => {
      alive = false;
    };
  }, [a.blobId, type, name, client]);

  const box = useRef<HTMLDivElement>(null);
  useModal(box, onClose);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && index < list.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [index, list.length, onClose, onIndex]);

  let body: ReactNode;
  if (/^image\//.test(type) && isPreviewable(type)) body = <img className="preview__img" src={downloadUrl} alt={name} />;
  else if (type === 'application/pdf') body = <iframe className="preview__pdf" src={inlineUrl} title={name} />;
  else if (/^text\//.test(type)) body = <pre className="preview__text">{text ?? 'Loading…'}</pre>;
  else if (/^audio\//.test(type)) body = <audio controls src={downloadUrl} />;
  else if (/^video\//.test(type)) body = <video className="preview__video" controls src={downloadUrl} />;
  else
    body = (
      <div className="preview__none">
        <Icon name={attachmentIcon(type, name)} size={64} />
        <div>No preview available</div>
        <a className="btn btn--filled" href={downloadUrl} download={name}>
          Download
        </a>
      </div>
    );

  return createPortal(
    <div ref={box} className="preview" role="dialog" aria-modal="true" aria-label={`Preview ${name}`}>
      <div className="preview__bar">
        <IconButton icon="arrow_back" label="Close" onClick={onClose} className="preview__btn" />
        <Icon name={attachmentIcon(type, name)} size={20} />
        <span className="preview__name">{name}</span>
        <span className="preview__size">{formatSize(a.size)}</span>
        <span className="preview__spacer" />
        <a className="icon-btn preview__btn" href={downloadUrl} download={name} aria-label="Download" data-tooltip="Download">
          <Icon name="download" size={20} />
        </a>
        <IconButton icon="close" label="Close" onClick={onClose} className="preview__btn" />
      </div>
      <div className="preview__stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {index > 0 ? (
          <IconButton
            icon="chevron_left"
            label="Previous"
            className="preview__nav preview__nav--prev"
            size={48}
            iconSize={32}
            onClick={() => onIndex(index - 1)}
          />
        ) : null}
        {body}
        {index < list.length - 1 ? (
          <IconButton
            icon="chevron_right"
            label="Next"
            className="preview__nav preview__nav--next"
            size={48}
            iconSize={32}
            onClick={() => onIndex(index + 1)}
          />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
