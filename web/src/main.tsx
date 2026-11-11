import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { UiProvider } from './components/ui';
import { StudioProvider } from './store';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <UiProvider>
        <StudioProvider>
          <App />
        </StudioProvider>
      </UiProvider>
    </BrowserRouter>
  </StrictMode>,
);
