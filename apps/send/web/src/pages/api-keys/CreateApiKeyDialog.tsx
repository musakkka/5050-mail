import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Info, TriangleAlert } from 'lucide-react';
import { apiKeys, domains as domainsApi } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import type { Permission } from '@/api/types';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tooltip } from '@/components/ui/Tooltip';
import { CopyButton, copyText } from '@/components/ui/CopyButton';
import { toast } from '@/components/ui/toast';
import { ApiError } from '@/api/http';

export const PERMISSIONS: { value: Permission; label: string; description: string }[] = [
  { value: 'full_access', label: 'Full access', description: 'Can create, delete, get, and update any resource.' },
  { value: 'sending_access', label: 'Sending access', description: 'Can only send emails.' },
];

export function permissionLabel(p?: string) {
  return PERMISSIONS.find((x) => x.value === p)?.label ?? 'Full access';
}

/**
 * "Add API Key" dialog (⌘↩ to submit). On success it switches to showing the new
 * token, which is never retrievable again.
 */
export function CreateApiKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState('');
  const [permission, setPermission] = useState<Permission>('full_access');
  const [domainId, setDomainId] = useState('all');
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const domains = useTeamQuery(['domains'], (t) => domainsApi.list(t), { enabled: open });

  useEffect(() => {
    if (open) {
      setName('');
      setPermission('full_access');
      setDomainId('all');
      setError(null);
      setToken(null);
    }
  }, [open]);
  useEffect(() => {
    if (permission === 'full_access') setDomainId('all');
  }, [permission]);

  const create = useTeamMutation(
    (t, _v: void) => apiKeys.create(t, { name: name.trim(), permission, domain_id: permission === 'sending_access' && domainId !== 'all' ? domainId : undefined }),
    [['api-keys']],
    { silent: true },
  );

  const submit = async () => {
    if (token) {
      onOpenChange(false);
      return;
    }
    if (!name.trim()) {
      setError('Enter a name for the API key');
      nameRef.current?.focus();
      return;
    }
    if (name.trim().length > 50) {
      setError('Use 50 characters or fewer');
      return;
    }
    setError(null);
    try {
      const r = await create.mutateAsync();
      setToken(r.token);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the API key');
    }
  };

  if (token) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange} title="View API Key" onSubmit={() => onOpenChange(false)}>
        <p className="mt-2 text-sm text-default">
          Copy your key now and store it somewhere safe. For security reasons <span className="text-emphasis">it won’t be shown again</span>.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <label htmlFor="new-token" className="text-sm text-default">
            API Key
          </label>
          <Input
            id="new-token"
            readOnly
            value={token}
            className="font-mono text-[13px]"
            onFocus={(e) => e.currentTarget.select()}
            rightWidth={36}
            right={<CopyButton value={token} label="Copy API key" />}
          />
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-warning-subtle bg-warning px-3 py-2 text-sm text-warning">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <span>Anyone with this key can {permission === 'full_access' ? 'manage your account' : 'send emails as you'}. Never commit it or share it in client-side code.</span>
        </div>
        <DialogActions>
          <Button
            variant="primary"
            kbd={['⌘', '↩︎']}
            onClick={async () => {
              if (await copyText(token)) toast.success('API key copied');
              onOpenChange(false);
            }}
          >
            Copy and close
          </Button>
          <Button kbd={['Esc']} onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  const domainOptions = [{ value: 'all', label: 'All domains' }, ...(domains.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add API Key" onSubmit={() => void submit()} initialFocus={nameRef}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <div className="mt-6 flex flex-col space-y-2">
          <label htmlFor="name" className="text-sm text-default">
            Name
          </label>
          <Input
            ref={nameRef}
            id="name"
            name="name"
            autoComplete="off"
            placeholder="Your API Key name"
            value={name}
            maxLength={60}
            invalid={!!error}
            aria-describedby={error ? 'name-error' : undefined}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
          />
          {error ? (
            <p id="name-error" role="alert" className="text-xs text-error">
              {error}
            </p>
          ) : null}
        </div>
        <div className="mt-6 flex flex-col space-y-2">
          <div className="flex items-center gap-1">
            <label htmlFor="permission" className="text-sm text-default flex items-center">
              Permission
            </label>
            <Tooltip
              content={
                <span className="flex flex-col gap-1">
                  {PERMISSIONS.map((p) => (
                    <span key={p.value}>
                      <span className="font-semibold">{p.label}:</span> {p.description}
                    </span>
                  ))}
                </span>
              }
            >
              <Info size={14} className="text-default" aria-label="About permissions" role="img" />
            </Tooltip>
          </div>
          <Select id="permission" ariaLabel="Permission" value={permission} onChange={setPermission} options={PERMISSIONS.map((p) => ({ value: p.value, label: p.label }))} className="max-w-[30rem]" />
        </div>
        <div className="mt-6 flex flex-col gap-2">
          <label htmlFor="domain" className="text-sm text-default">
            Domain
          </label>
          {permission === 'sending_access' ? (
            <Select id="domain" ariaLabel="Domain" value={domainId} onChange={setDomainId} options={domainOptions} />
          ) : (
            <Tooltip content="Domain restriction is only available for sending access keys.">
              <button
                type="button"
                id="domain"
                disabled
                data-disabled=""
                className="inline-flex w-full items-center justify-between border select-none relative cursor-not-allowed opacity-70 bg-interactive border-interactive text-default text-sm h-8 pl-3 pr-2 rounded-xl"
              >
                <span className="text-sm text-default font-normal text-left">All domains</span>
                <ChevronDown size={16} className="text-emphasis" />
              </button>
            </Tooltip>
          )}
        </div>
        <DialogActions>
          <Button type="submit" variant="primary" kbd={['⌘', '↩︎']} disabled={!name.trim()} loading={create.isPending}>
            Add
          </Button>
          <Button kbd={['Esc']} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
