import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { safeNext } from './lib/safeNext';
import { QueryClientProvider } from '@tanstack/react-query';
import { fetchMe, type Me } from './api/auth';
import { LoginPage } from './pages/LoginPage';
import { AdminPage } from './pages/AdminPage';
import { MailApp } from './pages/MailApp';
import { MailProvider, queryClient } from './state/mail';
import { TooltipLayer } from './components/ui/Tooltip';
import { BrandMark } from './components/ui/Logo';
import { useThemeSync } from './theme/theme';
import { useSettings } from './state/settings';

function BootScreen() {
  return (
    <div className="boot" aria-busy="true" aria-label="Loading 5050 Mail">
      <BrandMark height={48} />
      <div className="boot__bar">
        <div />
      </div>
    </div>
  );
}

/** Signed in already (or just now): continue to `?next=` when it's a safe same-origin path. */
function AfterLogin() {
  const [params] = useSearchParams();
  return <Navigate to={safeNext(params.get('next'))} replace />;
}

function RequireAuth({ me, children }: { me: Me | null; children: React.ReactNode }) {
  const loc = useLocation();
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const loadSettings = useSettings((s) => s.load);
  useThemeSync();

  useEffect(() => {
    fetchMe()
      .then((m) => {
        if (m) loadSettings(m.email);
        setMe(m);
      })
      .catch(() => setMe(null));
  }, [loadSettings]);

  if (me === undefined) return <BootScreen />;

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route
            path="/login"
            element={
              me ? (
                <AfterLogin />
              ) : (
                <LoginPage
                  onLogin={(m) => {
                    queryClient.clear();
                    loadSettings(m.email);
                    setMe(m);
                  }}
                />
              )
            }
          />
          <Route
            path="/admin/*"
            element={
              <RequireAuth me={me}>
                <AdminPage me={me!} />
              </RequireAuth>
            }
          />
          <Route
            path="/mail/*"
            element={
              <RequireAuth me={me}>
                <MailProvider me={me!} fallback={<BootScreen />}>
                  <MailApp />
                </MailProvider>
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/mail/inbox" replace />} />
        </Routes>
        <TooltipLayer />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
