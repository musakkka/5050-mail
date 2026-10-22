import type { Email } from '../../jmap/types';
import { Icon } from '../icons/Icon';
import { useMail } from '../../state/mail';
import { attachmentIcon } from './attachmentIcon';
import { formatSize } from '../../lib/format';
import { useAttachmentPreview } from './AttachmentPreview';

/** Attachment cards under a message (02-components §8.3). */
export function Attachments({ email }: { email: Email }) {
  const { client } = useMail();
  const preview = useAttachmentPreview();
  const html = Object.values(email.bodyValues ?? {})
    .map((v) => v.value)
    .join('');
  // Hide inline images that the HTML actually references.
  const list = (email.attachments ?? []).filter((a) => a.blobId && !(a.cid && html.includes(a.cid.replace(/^<|>$/g, ''))));
  if (!list.length) return preview.element as JSX.Element | null;
  return (
    <div className="atts">
      <div className="atts__head">
        <span>{list.length === 1 ? 'One attachment' : `${list.length} attachments`}</span>
        <span className="atts__scan"> • Scanned by 5050 Mail</span>
        {list.length > 1 ? (
          <button
            type="button"
            className="icon-btn atts__all"
            aria-label="Download all"
            data-tooltip="Download all"
            onClick={() => {
              for (const a of list) {
                const el = document.createElement('a');
                el.href = client.downloadUrl(a.blobId!, a.name ?? 'attachment', a.type);
                el.download = a.name ?? '';
                el.click();
              }
            }}
          >
            <Icon name="download" size={20} />
          </button>
        ) : null}
      </div>
      <div className="atts__grid">
        {list.map((a, i) => {
          const name = a.name ?? 'attachment';
          const isImg = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(a.type);
          const url = client.downloadUrl(a.blobId!, name, a.type);
          return (
            <div
              key={`${a.blobId}-${i}`}
              className="att-card"
              role="button"
              tabIndex={0}
              aria-label={`Preview ${name}`}
              onClick={() => preview.open(a, list)}
              onKeyDown={(e) => e.key === 'Enter' && preview.open(a, list)}
            >
              <div className="att-card__thumb">{isImg ? <img src={url} alt="" loading="lazy" /> : <Icon name={attachmentIcon(a.type, name)} size={40} />}</div>
              <div className="att-card__strip">
                <Icon name={attachmentIcon(a.type, name)} size={16} />
                <span className="att-card__name">{name}</span>
              </div>
              <div className="att-card__overlay">
                <div className="att-card__oname">{name}</div>
                <div className="att-card__osize">{formatSize(a.size)}</div>
                <a
                  className="att-card__dl"
                  href={url}
                  download={name}
                  aria-label={`Download ${name}`}
                  data-tooltip="Download"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Icon name="download" size={18} />
                </a>
              </div>
            </div>
          );
        })}
      </div>
      {preview.element}
    </div>
  );
}
