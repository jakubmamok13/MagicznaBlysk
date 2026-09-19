import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './lib/install-polyfills';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Nie znaleziono elementu #root — sprawdź index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
