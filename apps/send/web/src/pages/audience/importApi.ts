import { contacts as contactsApi } from '@/api/client';
import { BASE, CSRF_HEADERS, MOCK_ENABLED, ApiError, get } from '@/api/http';
import type { ParsedContact } from '@/lib/csv';
import { toCsv } from '@/lib/csv';

export interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
}

interface ContactImport {
  id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  counts?: { total: number; created: number; updated: number; skipped: number; failed: number };
}

/**
 * Import contacts. Real backend: POST /contacts/imports (multipart CSV, worker job)
 * then poll GET /contacts/imports/:id. Mock / older backends: JSON fallback.
 */
export async function importContacts(teamId: string, rows: ParsedContact[], segmentId: string | null, onProgress?: (s: string) => void): Promise<ImportResult> {
  if (MOCK_ENABLED) {
    const r = await contactsApi.import(teamId, { contacts: rows, segment_id: segmentId ?? undefined });
    return { imported: r.imported, updated: 0, skipped: r.skipped, failed: 0 };
  }
  const csv = toCsv(
    ['email', 'first_name', 'last_name', 'unsubscribed'],
    rows.map((r) => [r.email, r.first_name ?? '', r.last_name ?? '', r.unsubscribed === undefined ? '' : String(r.unsubscribed)]),
  );
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'contacts.csv');
  fd.append('on_conflict', 'upsert');
  if (segmentId) fd.append('segments', JSON.stringify([{ id: segmentId }]));
  const res = await fetch(`${BASE}/teams/${teamId}/resend/contacts/imports`, { method: 'POST', credentials: 'same-origin', headers: { ...CSRF_HEADERS, Accept: 'application/json' }, body: fd });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (res.status === 404 || res.status === 405) {
    const r = await contactsApi.import(teamId, { contacts: rows, segment_id: segmentId ?? undefined });
    return { imported: r.imported, updated: 0, skipped: r.skipped, failed: 0 };
  }
  if (!res.ok || !body.id) throw new ApiError(body.message ?? `Import failed (${res.status})`, res.status);
  for (let i = 0; i < 600; i++) {
    const s = await get<ContactImport>(`/teams/${teamId}/resend/contacts/imports/${body.id}`);
    onProgress?.(s.status === 'in_progress' ? 'Importing…' : s.status === 'queued' ? 'Queued…' : '');
    if (s.status === 'completed' || s.status === 'failed') {
      const c = s.counts ?? { total: rows.length, created: 0, updated: 0, skipped: 0, failed: 0 };
      if (s.status === 'failed' && !c.created && !c.updated) throw new ApiError('The import failed. Check the file and try again.', 422);
      return { imported: c.created, updated: c.updated, skipped: c.skipped, failed: c.failed };
    }
    await new Promise((r) => setTimeout(r, Math.min(3000, 500 + i * 100)));
  }
  throw new ApiError('The import is still running. Check back in a few minutes.', 202);
}
