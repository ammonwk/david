import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { GlobalShell } from './components/shell/GlobalShell';
import { ToastProvider } from './components/shell/ToastManager';
import { CommandCenter } from './pages/CommandCenter';
import { LogScanner } from './pages/LogScanner';
import { CodebaseMap } from './pages/CodebaseMap';
import { AgentMonitor } from './pages/AgentMonitor';
import { PRPipeline } from './pages/PRPipeline';

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route element={<GlobalShell />}>
            <Route path="/" element={<Navigate to="/command-center" replace />} />
            <Route path="/command-center" element={<CommandCenter />} />
            <Route path="/logs" element={<LogScanner />} />
            <Route path="/map" element={<CodebaseMap />} />
            <Route path="/agents" element={<AgentMonitor />} />
            <Route path="/prs" element={<PRPipeline />} />
          </Route>
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
