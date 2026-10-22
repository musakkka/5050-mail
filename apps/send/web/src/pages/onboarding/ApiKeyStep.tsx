import { useState } from 'react';
import { Lock } from 'lucide-react';
import { apiKeys } from '@/api/client';
import { useTeamMutation } from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { Input } from '@/components/ui/Input';
import { useSession } from '@/state/session';

/**
 * "Add API Key" button that creates a full-access key and then shows the token once
 * (it is kept only in memory, never in storage).
 */
export function ApiKeyStep({ name, token, onToken }: { name: string; token: string | null; onToken: (t: string) => void }) {
  const { canManage } = useSession();
  const [error, setError] = useState<string | null>(null);
  const create = useTeamMutation((t, n: string) => apiKeys.create(t, { name: n, permission: 'full_access' }), [['api-keys']], {
    silent: true,
    onSuccess: (r) => onToken(r.token),
  });
  if (token) {
    return (
      <div className="flex max-w-xl flex-col gap-2">
        <Input
          aria-label="Your new API key"
          value={token}
          readOnly
          className="font-mono"
          onFocus={(e) => e.currentTarget.select()}
          right={<CopyButton value={token} label="Copy API key" />}
          rightWidth={36}
        />
        <p className="text-xs text-default">Copy it now: for your security it won't be shown again. It was added to the code below.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="primary"
          icon={<Lock size={16} />}
          loading={create.isPending}
          disabled={!canManage}
          onClick={() => {
            setError(null);
            create.mutate(name, { onError: (e) => setError(e.message) });
          }}
        >
          Add API Key
        </Button>
      </div>
      {!canManage ? <p className="text-xs text-muted">Only team admins can create API keys. Ask an admin for a key.</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
