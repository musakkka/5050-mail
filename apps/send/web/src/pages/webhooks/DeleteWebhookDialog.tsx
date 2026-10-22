import { useNavigate } from 'react-router-dom';
import { webhooks as api } from '@/api/client';
import { useTeamMutation } from '@/api/hooks';
import type { Webhook } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogActions } from '@/components/ui/Dialog';
import { toast } from '@/components/ui/toast';

/** Confirm and delete a webhook; `redirect` navigates back to the list afterwards. */
export function DeleteWebhookDialog({ webhook, onOpenChange, redirect }: { webhook: Webhook | null; onOpenChange: (o: boolean) => void; redirect?: boolean }) {
  const nav = useNavigate();
  const del = useTeamMutation((t, id: string) => api.remove(t, id), [['webhooks']], {
    onSuccess: () => {
      toast.success('Webhook deleted');
      onOpenChange(false);
      if (redirect) nav('/webhooks', { replace: true });
    },
  });
  const submit = () => webhook && !del.isPending && del.mutate(webhook.id);
  return (
    <Dialog
      open={!!webhook}
      onOpenChange={onOpenChange}
      title="Delete webhook"
      onSubmit={submit}
      description={
        <>
          Events will stop being sent to <span className="break-all font-mono text-[13px] text-emphasis">{webhook?.endpoint}</span>. Its delivery history is deleted too. This can't be undone.
        </>
      }
    >
      <DialogActions>
        <Button variant="danger" kbd={['⌘', '↩︎']} loading={del.isPending} onClick={submit}>
          Delete
        </Button>
        <Button onClick={() => onOpenChange(false)} kbd={['Esc']}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}
