import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { HandoffProvider } from './state';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HandoffProvider>
      <App />
    </HandoffProvider>
  </StrictMode>,
);
