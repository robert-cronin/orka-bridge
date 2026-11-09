import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './app.css';
import './shell.css';
import App from './App';

// Smoke demo only: render 8 s after the window appears.
setTimeout(() => createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
), 8000);
