import { AgentPoolGauge } from '../components/command-center/AgentPoolGauge';
import { EventTimeline } from '../components/command-center/EventTimeline';
import { HealthVitals } from '../components/command-center/HealthVitals';

/**
 * Command Center — the default landing page.
 *
 * Three-column operational summary filling the full viewport height:
 * - Left: Agent Pool Gauge (pool capacity visualization)
 * - Center: Live Event Timeline (auto-scrolling system events)
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

      {/* Center — Live Event Timeline */}
      <section className="flex flex-col overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-3">
        <EventTimeline />
      </section>

      {/* Right — Health Vitals */}
      <section className="flex flex-col overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-3">
        <HealthVitals />
      </section>
    </div>
  );
}
