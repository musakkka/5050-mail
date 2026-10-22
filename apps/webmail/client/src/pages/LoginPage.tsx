import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BrandMark } from '../components/ui/Logo';
import { login, type Me } from '../api/auth';
import { safeNext } from '../lib/safeNext';

export function LoginPage({ onLogin }: { onLogin: (me: Me) => void }) {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await login(email.trim(), password);
      setPassword('');
      onLogin(me);
      nav(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit} noValidate>
        <div className="login__brand">
          <BrandMark height={36} title="5050 Mail" />
        </div>
        <h1 className="login__title">Sign in</h1>
        <p className="login__sub">to continue to 5050 Mail</p>
        <label className={`ofield${error ? ' ofield--error' : ''}`}>
          <input
            className="ofield__input"
            type="email"
            name="email"
            autoComplete="username"
            placeholder=" "
            value={email}
            autoFocus
            required
            onChange={(e) => setEmail(e.target.value)}
          />
          <span className="ofield__label">Email</span>
        </label>
        <label className={`ofield${error ? ' ofield--error' : ''}`}>
          <input
            className="ofield__input"
            type={show ? 'text' : 'password'}
            name="password"
            autoComplete="current-password"
            placeholder=" "
            value={password}
            required
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="ofield__label">Password</span>
        </label>
        {error ? (
          <div className="login__error" role="alert">
            {error}
          </div>
        ) : null}
        <label className="login__show">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          <span>Show password</span>
        </label>
        <div className="login__actions">
          <span className="login__hint">Use your 5050 Mail address and password.</span>
          <button type="submit" className="btn btn--filled" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
      <footer className="login__footer">5050 Mail · email on your own domains</footer>
    </div>
  );
}
