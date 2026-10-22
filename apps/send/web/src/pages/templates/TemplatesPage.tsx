import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ellipsis, FileCode, GalleryHorizontal, LayoutGrid, List as ListIcon, Plus } from 'lucide-react';
import { templates as api } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { Template } from '@/api/types';
import { PageBody, PageHeader, DashedLink } from '@/components/layout/Page';
import { ApiDrawerButton, API } from '@/components/layout/ApiDrawer';
import { Button, iconButtonClass } from '@/components/ui/Button';
import { SearchInput } from '@/components/ui/ListControls';
import { Select } from '@/components/ui/Select';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Table, THead, Th, TBody, Td, SkeletonRows } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { AppIcon } from '@/components/ui/AppIcon';
import { Tooltip } from '@/components/ui/Tooltip';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import { fullDateTime, timeAgoShort } from '@/lib/format';
import { cn } from '@/lib/cn';
import { renderPreview } from './vars';

const STARTER = `<!doctype html>
<html>
  <body style="font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; background: #f6f6f4; padding: 32px;">
    <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 32px;">
      <h1 style="font-size: 22px; margin: 0 0 16px;">Hi {{{FIRST_NAME|there}}},</h1>
      <p style="font-size: 15px; line-height: 24px;">Write your message here.</p>
    </div>
  </body>
</html>`;

type View = 'card' | 'table';

function useView(): [View, (v: View) => void] {
  const [v, setV] = useState<View>(() => {
    try {
      return (localStorage.getItem('send.templates.view') as View) || 'card';
    } catch {
      return 'card';
    }
  });
  return [
    v,
    (n) => {
      setV(n);
      try {
        localStorage.setItem('send.templates.view', n);
      } catch {
        /* ignore */
      }
    },
  ];
}

function statusBadge(t: Template) {
  return t.status === 'published' ? <Badge tone="success">published</Badge> : <Badge tone="neutral">draft</Badge>;
}

/** Scaled, sandboxed HTML thumbnail (no scripts, no network beyond images). */
function Thumbnail({ id }: { id: string }) {
  const q = useTeamQuery(['templates', id], (t) => api.get(t, id));
  const html = q.data?.html ? renderPreview(q.data.html, q.data.variables ?? [], false) : '';
  return (
    <div className="relative h-44 overflow-hidden rounded-t-2xl border-b border-default bg-white">
      {q.isPending ? (
        <Skeleton className="absolute inset-0 rounded-none" />
      ) : html ? (
        <iframe
          title="Template preview"
          sandbox=""
          srcDoc={html}
          tabIndex={-1}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
          style={{ width: '250%', height: '250%', transform: 'scale(0.4)' }}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-gray-7">Empty template</div>
      )}
    </div>
  );
}

export function TemplatesPage() {
  const nav = useNavigate();
  const [view, setView] = useView();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'draft' | 'published'>('all');
  const [toDelete, setToDelete] = useState<Template | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useTeamQuery(['templates'], (t) => api.list(t));
  const create = useTeamMutation((t, b: Partial<Template>) => api.create(t, b), [['templates']], { onSuccess: (r) => nav(`/templates/${r.id}`) });
  const duplicate = useTeamMutation((t, id: string) => api.duplicate(t, id), [['templates']], { onSuccess: () => toast.success('Template duplicated') });
  const remove = useTeamMutation((t, id: string) => api.remove(t, id), [['templates']], {
    onSuccess: () => {
      toast.success('Template deleted');
      setToDelete(null);
    },
  });

  const rows = useMemo(() => {
    const s = q.toLowerCase();
    return (list.data?.data ?? []).filter((t) => (status === 'all' || t.status === status) && (!s || t.name.toLowerCase().includes(s) || (t.alias ?? '').toLowerCase().includes(s) || t.id === s));
  }, [list.data, q, status]);

  const newBlank = () => create.mutate({ name: 'Untitled template', html: STARTER, variables: [] });
  const importHtml = async (f: File) => {
    if (f.size > 2 * 1024 * 1024) {
      toast.error('That file is larger than 2 MB.');
      return;
    }
    const html = await f.text();
    create.mutate({ name: f.name.replace(/\.html?$/i, '') || 'Imported template', html });
  };

  const newMenu = (label = 'New', icon = true) => (
    <Menu
      align="end"
      className="w-56"
      trigger={
        <Button variant="primary" icon={icon ? <Plus size={16} /> : undefined} loading={create.isPending} className="w-fit">
          {label}
        </Button>
      }
    >
      <MenuItem icon={<GalleryHorizontal />} onClick={newBlank}>
        Blank template
      </MenuItem>
      <MenuItem icon={<FileCode />} onClick={() => fileRef.current?.click()}>
        Import HTML file
      </MenuItem>
    </Menu>
  );

  const actions = (t: Template) => (
    <Menu
      align="end"
      className="w-44"
      trigger={
        <button type="button" aria-label={`More actions for ${t.name}`} className={iconButtonClass('ghost', '2', 'align-middle')} onClick={(e) => e.stopPropagation()}>
          <span className="inline-flex items-center justify-center opacity-100">
            <Ellipsis size={12} strokeWidth={3} />
          </span>
        </button>
      }
    >
      <MenuItem onClick={() => nav(`/templates/${t.id}`)}>Edit</MenuItem>
      <MenuItem onClick={() => duplicate.mutate(t.id)}>Duplicate</MenuItem>
      <MenuItem
        onClick={() => {
          void navigator.clipboard?.writeText(t.alias ?? t.id).then(() => toast(t.alias ? 'Alias copied' : 'Template ID copied'));
        }}
      >
        Copy {t.alias ? 'alias' : 'ID'}
      </MenuItem>
      <MenuSeparator />
      <MenuItem danger onClick={() => setToDelete(t)}>
        Delete
      </MenuItem>
    </Menu>
  );

  const all = list.data?.data ?? [];
  const empty = !list.isPending && !list.error && all.length === 0;

  return (
    <>
      <PageHeader
        title="Templates"
        actions={
          <>
            {newMenu()}
            <ApiDrawerButton examples={API.templates!} />
          </>
        }
      />
      <PageBody>
        <input
          ref={fileRef}
          type="file"
          accept=".html,.htm,text/html"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importHtml(f);
          }}
        />
        <div className="mb-4 flex flex-row gap-2 w-full justify-between">
          <SearchInput value={q} onChange={setQ} className="w-full" />
          <Select
            value={status}
            onChange={setStatus}
            ariaLabel="Status"
            className="max-w-[200px]"
            options={[
              { value: 'all', label: 'All statuses' },
              { value: 'published', label: 'Published' },
              { value: 'draft', label: 'Draft' },
            ]}
          />
          <div aria-label="Switch view" className="inline-flex items-center rounded-xl bg-interactive dark:bg-elevated p-0.5 gap-1 h-8 shrink-0" role="radiogroup">
            {(
              [
                ['card', 'Card view', LayoutGrid],
                ['table', 'Table view', ListIcon],
              ] as const
            ).map(([v, label, Icon]) => (
              <Tooltip key={v} content={label}>
                <button
                  aria-label={label}
                  type="button"
                  role="radio"
                  aria-checked={view === v}
                  onClick={() => setView(v)}
                  className="flex items-center justify-center rounded-[0.62rem] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus text-emphasis dark:text-default hover:bg-interactive-hover aspect-square border border-transparent aria-checked:text-emphasis aria-checked:bg-interactive-hover dark:aria-checked:text-emphasis h-7"
                >
                  <Icon size={16} />
                </button>
              </Tooltip>
            ))}
          </div>
        </div>

        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : empty ? (
          <EmptyState
            icon={
              <AppIcon size={105} tone="gray" glyphSize={44}>
                <GalleryHorizontal strokeWidth={1.75} />
              </AppIcon>
            }
            title="No templates yet"
            description="Create a new template or import an existing one to reuse in your emails."
            actions={
              <Button variant="primary" icon={<Plus size={16} />} onClick={newBlank} loading={create.isPending} className="w-fit">
                Create template
              </Button>
            }
          />
        ) : !list.isPending && rows.length === 0 ? (
          <EmptyState compact title="No templates found" description="No templates match your search." />
        ) : view === 'card' ? (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy={list.isPending}>
            {list.isPending
              ? Array.from({ length: 3 }, (_, i) => (
                  <li key={i} className="rounded-2xl border border-default">
                    <Skeleton className="h-44 rounded-b-none rounded-t-2xl" />
                    <div className="p-4">
                      <Skeleton className="h-4 w-40" />
                    </div>
                  </li>
                ))
              : rows.map((t) => (
                  <li key={t.id} className="group relative rounded-2xl border border-default transition-colors hover:border-interactive focus-within:border-interactive">
                    <Thumbnail id={t.id} />
                    <div className="flex items-center justify-between gap-2 p-4 pr-2">
                      <div className="min-w-0">
                        <a
                          href={`/templates/${t.id}`}
                          onClick={(e) => {
                            e.preventDefault();
                            nav(`/templates/${t.id}`);
                          }}
                          className="block truncate text-sm font-semibold text-emphasis outline-hidden after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-focus"
                          title={t.name}
                        >
                          {t.name}
                        </a>
                        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-default">
                          {statusBadge(t)}
                          <Tooltip content={fullDateTime(t.updated_at)}>
                            <span className="truncate">Edited {timeAgoShort(t.updated_at)}</span>
                          </Tooltip>
                        </div>
                      </div>
                      <div className="relative z-10 shrink-0">{actions(t)}</div>
                    </div>
                  </li>
                ))}
          </ul>
        ) : (
          <Table>
            <THead>
              <Th>Name</Th>
              <Th className="w-[200px]">Alias</Th>
              <Th className="w-[140px]">Status</Th>
              <Th className="text-right w-[160px]">Updated</Th>
              <Th className="w-[70px]">
                <span className="sr-only">Actions</span>
              </Th>
            </THead>
            <TBody>
              {list.isPending ? (
                <SkeletonRows cols={5} />
              ) : (
                rows.map((t) => (
                  <tr key={t.id}>
                    <Td className="py-3 max-w-[360px]">
                      <div className="group flex items-center gap-3 w-full min-w-0">
                        <AppIcon size={32} tone={t.status === 'published' ? 'green' : 'gray'} glyphSize={16}>
                          <GalleryHorizontal />
                        </AppIcon>
                        <DashedLink to={`/templates/${t.id}`} title={t.name}>
                          {t.name}
                        </DashedLink>
                      </div>
                    </Td>
                    <Td className={cn('max-w-[200px] font-mono text-[13px]', !t.alias && 'text-muted')}>
                      <div className="truncate">{t.alias ?? '—'}</div>
                    </Td>
                    <Td>{statusBadge(t)}</Td>
                    <Td className="text-right">
                      <Tooltip content={fullDateTime(t.updated_at)}>
                        <time dateTime={t.updated_at}>{timeAgoShort(t.updated_at)}</time>
                      </Tooltip>
                    </Td>
                    <Td className="text-center">{actions(t)}</Td>
                  </tr>
                ))
              )}
            </TBody>
          </Table>
        )}
      </PageBody>
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete template"
        description={
          <>
            <span className="text-emphasis break-all">{toDelete?.name}</span> will be deleted. Emails and automations that use it will fail to send.
          </>
        }
        loading={remove.isPending}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete.id);
        }}
      />
    </>
  );
}
