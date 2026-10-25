import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Tailwind + Studio Dark tokens first; legacy styles.css second so its
// element-selector rules still win for markup not yet migrated (ADR-0008).
import './index.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
