import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './site.css';

const root = document.getElementById('root');
if (!root) throw new Error('React root is missing');

createRoot(root).render(<StrictMode><App /></StrictMode>);
