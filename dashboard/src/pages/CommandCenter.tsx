import { AgentPoolGauge } from '../components/command-center/AgentPoolGauge';
import { CodebaseHealth } from '../components/command-center/CodebaseHealth';
import { HealthVitals } from '../components/command-center/HealthVitals';

/**
 * Command Center — the default landing page.
 *
 * Three-column operational summary filling the full viewport height:
 * - Left: Agent Pool Gauge (pool capacity visualization)
 * - Center: Codebase Health (known issues, resolved issues, baselines)
 * - Right: Health Vitals (mini charts + stat grid)
 */
export function CommandCenter() {
  return (
    <div
      className="grid grid-cols-[260px_1fr_280px] gap-4 animate-fade-in"
      style={{ height: 'calc(100vh - 2.75rem - 2rem - 3rem)' }}
    >
      {/* Left — Agent Pool Gauge */}
      <section className="flex flex-col overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-3">
        <AgentPoolGauge />
      </section>

      {/* Center — Codebase Health */}
      <section className="flex flex-col overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-3">
        <CodebaseHealth />
      </section>

      {/* Right — Health Vitals */}
      <section className="flex flex-col overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-3">
        <HealthVitals />
      </section>
    </div>
  );
}
