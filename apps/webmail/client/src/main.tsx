import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/google-sans-flex';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import './theme/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/list.css';
import './styles/thread.css';
import './styles/compose.css';
import './styles/misc.css';
import './styles/admin.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
