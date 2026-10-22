import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { teams } from '@/api/client';
import { useTeamMutation, useTeamQuery } from '@/api/hooks';
import { Badge } from '@/components/ui/Badge';
import { Switch } from '@/components/ui/Switch';
import { toast } from '@/components/ui/toast';
import { useSession } from '@/state/session';
import { SettingsLayout } from './SettingsLayout';

const FEATURES = [
  {
    key: 'inboxes',
    name: 'Inboxes',
    description: 'Receive email on your domains: create addresses, forward incoming messages and read them in the dashboard. Needs a domain with receiving enabled.',
    to: '/inboxes',
  },
  {
    key: 'automations',
    name: 'Automations',
    description: 'Send email sequences when your app reports an event, with delays and conditions between steps.',
    to: '/automations',
  },
];

/** Beta switches stored in the team's settings.labs. */
export function LabsPage() {
  const { team: sessionTeam, canManage } = useSession();
  const qc = useQueryClient();
  const detail = useTeamQuery(['team-detail'], (t) => teams.get(t));
  const team = detail.data ?? sessionTeam;
  const labs = (team.settings?.labs ?? {}) as Record<string, boolean>;
  const save = useTeamMutation((t, v: { key: string; on: boolean }) => teams.update(t, { settings: { labs: { ...labs, [v.key]: v.on } } }), [['team-detail']], {
    onSuccess: async (_r, v) => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast.success(`${FEATURES.find((f) => f.key === v.key)?.name} ${v.on ? 'enabled' : 'disabled'}`);
    },
  });
  return (
    <SettingsLayout title="Labs">
      {FEATURES.map((f) => (
        <div key={f.key} className="relative w-full rounded-3xl border border-default">
          <div
            aria-hidden="true"
            className="absolute right-0 top-0 hidden h-px w-[200px] dark:block"
            style={{ background: 'linear-gradient(90deg, rgba(56,189,248,0) 0%, rgba(232,232,232,0.2) 33%, rgba(143,143,143,0.67) 64%, rgba(236,72,153,0) 99%)' }}
          />
          <div className="flex items-center gap-2 p-4 pb-2">
            <h3 className="text-base text-emphasis font-semibold">{f.name}</h3>
            <Badge capitalize={false}>Beta</Badge>
          </div>
          <div className="p-4">
            <p className="max-w-2xl text-sm text-default font-normal">{f.description}</p>
          </div>
          <div className="flex items-center gap-4 border-t border-default p-3">
            <Switch
              checked={!!labs[f.key]}
              disabled={!canManage || save.isPending}
              label={f.name}
              onChange={(on) => save.mutate({ key: f.key, on })}
            />
            <Link to={f.to} className="inline-flex items-center gap-1 text-sm text-emphasis transition-opacity duration-300 hover:opacity-80">
              Open {f.name}
              <ArrowUpRight size={12} className="shrink-0" />
            </Link>
            {!canManage ? <span className="text-xs text-muted">Only team admins can change Labs.</span> : null}
          </div>
        </div>
      ))}
    </SettingsLayout>
  );
}
