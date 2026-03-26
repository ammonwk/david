import { useState, useCallback } from 'react';
import { GitPullRequest } from 'lucide-react';
import { KanbanBoard } from '../components/pr-pipeline/KanbanBoard';
import { LearningStrip } from '../components/pr-pipeline/LearningStrip';
import { PipelineDetail } from '../components/pr-pipeline/PipelineDetail';
import type { PipelineCardData } from '../components/pr-pipeline/PipelineCard';

export function PRPipeline() {
  const [selectedCard, setSelectedCard] = useState<PipelineCardData | null>(
    null,
  );

  const handleCardClick = useCallback((card: PipelineCardData) => {
    setSelectedCard(card);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedCard(null);
  }, []);

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Page header */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10 ring-1 ring-blue-500/20">
          <GitPullRequest className="h-5 w-5 text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            PR Pipeline
          </h1>
          <p className="text-xs text-[var(--text-muted)]">
            Bug-to-merge lifecycle managed by David
          </p>
        </div>
      </div>

      {/* Kanban board — takes remaining space */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <KanbanBoard onCardClick={handleCardClick} />
      </div>

      {/* Learning strip — always visible at bottom */}
      <div className="shrink-0">
        <LearningStrip />
      </div>

      {/* Detail panel — slides in from right on card click */}
      <PipelineDetail card={selectedCard} onClose={handleCloseDetail} />
    </div>
  );
}
