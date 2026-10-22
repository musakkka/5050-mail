import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { auth } from '@/api/client';
import { ApiError } from '@/api/http';
import { BrandMark } from '@/components/brand/BrandMark';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useTitle } from '@/components/layout/Page';

/** Sign in with a 5050 Mail account (session cookie), in the reference's login style. */
export function LoginPage() {
  useTitle('Log in');
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => emailRef.current?.focus(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.login(email.trim(), password);
      setPassword('');
      await qc.invalidateQueries({ queryKey: ['me'] });
      const next = params.get('next');
      nav(next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/emails', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-background px-4 py-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[-120px] h-[340px] w-[min(720px,140vw)] -translate-x-1/2 rounded-full opacity-[0.12] blur-[90px]"
        style={{ background: 'linear-gradient(180deg, #D9D9D9 0%, #737373 100%)' }}
      />
      <main className="relative w-full max-w-[380px]">
        <div className="mb-8 flex flex-col items-center gap-6 text-center">
          <BrandMark height={36} title="5050 Send" />
          <div>
            <h1 className="font-display effect-font-styling text-[28px] leading-[34px] tracking-[-0.045rem] text-emphasis font-medium">Log in to 5050 Send</h1>
            <p className="mt-2 text-sm text-default">Use your 5050 Mail address and password.</p>
          </div>
        </div>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="email" className="text-sm text-default">
              Email
            </label>
            <Input
              ref={emailRef}
              id="email"
              type="email"
              name="email"
              autoComplete="username"
              placeholder="you@yourcompany.com"
              value={email}
              invalid={!!error}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="password" className="text-sm text-default">
              Password
            </label>
            <Input
              id="password"
              type={show ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              invalid={!!error}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10"
              rightWidth={40}
              right={
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? 'Hide password' : 'Show password'}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-default hover:bg-interactive-hover hover:text-emphasis focus-visible:ring-2 focus-visible:ring-focus outline-hidden"
                >
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              }
            />
          </div>
          {error ? (
            <p role="alert" className="rounded-xl border border-error-subtle bg-error px-3 py-2 text-sm text-error">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="3" loading={busy} className="mt-2 w-full">
            {busy ? 'Logging in…' : 'Log in'}
          </Button>
        </form>
        <p className="mt-8 text-center text-xs text-muted">
          No account? Ask your 5050 administrator to add you to a team.
          <br />
          Forgot your password? Reset it in 5050 Mail.
        </p>
      </main>
    </div>
  );
}
