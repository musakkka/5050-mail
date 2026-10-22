import type { IconKey } from '../icons/Icon';

export function attachmentIcon(type: string | null | undefined, name?: string | null): IconKey {
  const t = (type ?? '').toLowerCase();
  const n = (name ?? '').toLowerCase();
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'picture_as_pdf';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('audio/')) return 'audio_file';
  if (t.startsWith('video/')) return 'video_file';
  if (/spreadsheet|excel|csv/.test(t) || /\.(xlsx?|csv|ods)$/.test(n)) return 'table_chart';
  if (/presentation|powerpoint/.test(t) || /\.(pptx?|odp|key)$/.test(n)) return 'slideshow';
  if (/zip|compressed|x-tar|gzip|x-7z|rar/.test(t) || /\.(zip|tar|gz|7z|rar)$/.test(n)) return 'folder_zip';
  if (/calendar/.test(t) || n.endsWith('.ics')) return 'event';
  if (t.startsWith('text/') || /word|document|rtf|opendocument\.text/.test(t)) return 'description';
  return 'draft';
}

export function isPreviewable(type: string | null | undefined): boolean {
  const t = (type ?? '').toLowerCase();
  return (
    /^image\/(png|jpe?g|gif|webp|bmp|avif)$/.test(t) ||
    t === 'application/pdf' ||
    t === 'text/plain' ||
    t === 'text/csv' ||
    t.startsWith('audio/') ||
    t.startsWith('video/')
  );
}
