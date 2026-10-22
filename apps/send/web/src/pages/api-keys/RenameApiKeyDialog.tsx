import { useEffect, useRef, useState } from 'react';
import { apiKeys } from '@/api/client';
import { useTeamMutation } from '@/api/hooks';
import type { ApiKey } from '@/api/types';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { toast } from '@/components/ui/toast';

export function RenameApiKeyDialog({ k, onClose }: { k: ApiKey | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setName(k?.name ?? ''), [k]);
  const save = useTeamMutation((t, v: { id: string; name: string }) => apiKeys.rename(t, v.id, v.name), [['api-keys']], {
    onSuccess: () => {
      toast.success('API key renamed');
      onClose();
    },
  });
  const valid = name.trim().length > 0 && name.trim().length <= 50;
  const submit = () => {
    if (k && valid && name.trim() !== k.name) save.mutate({ id: k.id, name: name.trim() });
    else if (k && name.trim() === k.name) onClose();
  };
  return (
    <Dialog open={!!k} onOpenChange={(o) => !o && onClose()} title="Edit API Key" onSubmit={submit} initialFocus={ref}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="mt-6 flex flex-col space-y-2">
          <label htmlFor="rename" className="text-sm text-default">
            Name
          </label>
          <Input ref={ref} id="rename" autoComplete="off" value={name} invalid={!valid} onChange={(e) => setName(e.target.value)} />
          {!valid ? <p className="text-xs text-error">Use between 1 and 50 characters.</p> : null}
        </div>
        <DialogActions>
          <Button type="submit" variant="primary" kbd={['⌘', '↩︎']} disabled={!valid} loading={save.isPending}>
            Save
          </Button>
          <Button kbd={['Esc']} onClick={onClose}>
            Cancel
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
