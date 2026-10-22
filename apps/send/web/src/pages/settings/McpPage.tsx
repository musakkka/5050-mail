import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Cable, CircleCheck } from 'lucide-react';
import { AppIcon } from '@/components/ui/AppIcon';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { PageBody, useTitle } from '@/components/layout/Page';
import { API_BASE } from '@/lib/config';
import { Step, Steps, type StepState } from '../onboarding/Stepper';
import { TabbedCode, type CodeTab } from '../onboarding/TabbedCode';
import { ApiKeyStep } from '../onboarding/ApiKeyStep';

const SERVER = '5050-send';
const PKG = 'resend-mcp';

/**
 * The open-source Resend MCP server (npm "resend-mcp") runs locally over stdio and
 * talks to 5050 Send through the Resend SDK's RESEND_BASE_URL override.
 */
function clients(key: string): CodeTab[] {
  const env = { RESEND_API_KEY: key, RESEND_BASE_URL: API_BASE };
  const std = JSON.stringify({ mcpServers: { [SERVER]: { command: 'npx', args: ['-y', PKG], env } } }, null, 2);
  return [
    { id: 'claude', label: 'Claude Desktop', lang: 'json', intro: <>Add to <code className="font-mono text-emphasis">claude_desktop_config.json</code> (Settings → Developer → Edit config), then restart Claude:</>, code: std },
    {
      id: 'claude-code',
      label: 'Claude Code',
      lang: 'bash',
      intro: 'Run in your project:',
      code: `claude mcp add ${SERVER} \\\n  -e RESEND_API_KEY=${key} \\\n  -e RESEND_BASE_URL=${API_BASE} \\\n  -- npx -y ${PKG}`,
    },
    { id: 'cursor', label: 'Cursor', lang: 'json', intro: <>Add to <code className="font-mono text-emphasis">~/.cursor/mcp.json</code>:</>, code: std },
    {
      id: 'vscode',
      label: 'VS Code',
      lang: 'json',
      intro: <>Add to <code className="font-mono text-emphasis">.vscode/mcp.json</code> (GitHub Copilot agent mode):</>,
      code: JSON.stringify({ servers: { [SERVER]: { type: 'stdio', command: 'npx', args: ['-y', PKG], env } } }, null, 2),
    },
    {
      id: 'codex',
      label: 'Codex',
      lang: 'bash',
      intro: <>Add to <code className="font-mono text-emphasis">~/.codex/config.toml</code>:</>,
      code: `[mcp_servers.${SERVER}]\ncommand = "npx"\nargs = ["-y", "${PKG}"]\nenv = { RESEND_API_KEY = "${key}", RESEND_BASE_URL = "${API_BASE}" }`,
    },
    { id: 'windsurf', label: 'Windsurf', lang: 'json', intro: <>Add to <code className="font-mono text-emphasis">~/.codeium/windsurf/mcp_config.json</code>:</>, code: std },
    { id: 'gemini', label: 'Gemini CLI', lang: 'json', intro: <>Add to <code className="font-mono text-emphasis">~/.gemini/settings.json</code>:</>, code: std },
    {
      id: 'zed',
      label: 'Zed',
      lang: 'json',
      intro: <>Add to Zed's <code className="font-mono text-emphasis">settings.json</code>:</>,
      code: JSON.stringify({ context_servers: { [SERVER]: { command: 'npx', args: ['-y', PKG], env } } }, null, 2),
    },
  ];
}

const PROMPTS = [
  'Send a test email from onboarding@<your verified domain> to me with the subject “Hello from 5050 Send”.',
  'List my domains and tell me which DNS records are still missing.',
  'Create a contact for ada@example.com in the General segment.',
];

export function McpPage() {
  useTitle('MCP Integration');
  const [client, setClient] = useState('claude');
  const [step, setStep] = useState(0);
  const [token, setToken] = useState<string | null>(null);
  const key = token ?? 're_xxxxxxxxx';
  const state = (i: number): StepState => (i < step ? 'done' : i === step ? 'active' : 'upcoming');
  return (
    <>
      <div className="mx-auto w-full max-w-6xl px-6 pt-2 pb-8 md:pt-8">
        <div className="flex items-center gap-6 py-12">
          <AppIcon size={80} tone="gray" glyphSize={36}>
            <Cable strokeWidth={1.75} />
          </AppIcon>
          <div className="min-w-0">
            <Link to="/settings/integrations" className="text-sm text-default font-semibold hover:text-emphasis">
              Integrations
            </Link>
            <h1 className="font-display effect-font-styling text-[28px] leading-[34px] tracking-[-0.045rem] text-emphasis font-medium">MCP server</h1>
          </div>
        </div>
      </div>
      <PageBody className="-mt-14">
        <Steps className="py-12 sm:ml-10">
          <Step state={state(0)} title="Add the MCP server" description="Choose the AI tool you want to connect to 5050 Send. The server runs on your machine and calls the 5050 Send API.">
            <TabbedCode
              tabs={clients(key)}
              value={client}
              onChange={setClient}
              height={200}
              footer={
                <Button variant="primary" icon={<CircleCheck size={16} />} onClick={() => setStep((s) => Math.max(s, 1))}>
                  I've added the server
                </Button>
              }
            />
          </Step>
          <Step
            state={state(1)}
            title="Authenticate"
            description="The server uses an API key. Create one here and it is filled into the configuration above; restart your AI tool afterwards."
          >
            {step >= 1 ? (
              <div className="flex flex-col gap-4">
                <ApiKeyStep name="MCP server" token={token} onToken={setToken} />
                <div>
                  <Button onClick={() => setStep((s) => Math.max(s, 2))}>{token ? 'Continue' : 'I already have a key'}</Button>
                </div>
              </div>
            ) : null}
          </Step>
          <Step state={state(2)} title="Send your first email" description="Ask your AI tool to do something with 5050 Send, for example:">
            {step >= 2 ? (
              <ul className="flex flex-col gap-2">
                {PROMPTS.map((p) => (
                  <li key={p} className="flex items-center justify-between gap-3 rounded-2xl border border-gray-3 bg-gray-a1/20 px-4 py-3 text-sm text-emphasis">
                    <span className="min-w-0 break-words">{p}</span>
                    <CopyButton value={p} />
                  </li>
                ))}
              </ul>
            ) : null}
          </Step>
        </Steps>
      </PageBody>
    </>
  );
}
