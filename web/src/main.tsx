import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// index.css sets up Tailwind + the Studio Dark tokens and pulls styles.css into
// the `legacy` cascade layer (see index.css). Don't import styles.css directly
// here — an unlayered import would defeat the layer ordering (ADR-0008).
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
