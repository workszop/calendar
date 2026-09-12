import React from 'react';
import { Calendar, Clock, Users, CheckCircle2, ChevronRight, Plus } from 'lucide-react';
import type { PollSummary } from '../types';
import { formatDateHeading } from '../utils/calendar';
import { Modal } from './Modal';

// ─── Types ───
interface PollListModalProps {
  isOpen: boolean;
  onClose: () => void;
  polls: PollSummary[];
  activePollId: string | null;
  onSelectPoll: (id: string) => void;
  onOpenNewPoll: () => void;
}

// ─── Component ───
export const PollListModal: React.FC<PollListModalProps> = ({
  isOpen,
  onClose,
  polls,
  activePollId,
  onSelectPoll,
  onOpenNewPoll,
}) => {
  const startNewPoll = () => {
    onOpenNewPoll();
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Meeting Polls"
      subtitle="Switch or browse meeting polls in this workspace"
      panelClassName="max-w-lg"
    >
      {polls.length === 0 ? (
        <div className="py-6 text-center space-y-3">
          <p className="text-sm text-stone-500">No meeting polls yet in this workspace.</p>
          <button type="button" onClick={startNewPoll} className="edu-btn-primary">
            <Plus className="w-3.5 h-3.5" />
            Create a poll
          </button>
        </div>
      ) : (
        <>
          <div className="space-y-2.5">
            {polls.map((p) => {
              const isActive = p.id === activePollId;
              const firstDate = p.dates[0] ? formatDateHeading(p.dates[0]).dayMonth : '';
              const lastDate = p.dates.length
                ? formatDateHeading(p.dates[p.dates.length - 1]).dayMonth
                : '';
              const dateRangeStr = firstDate === lastDate ? firstDate : `${firstDate} to ${lastDate}`;

              return (
                <button
                  key={p.id}
                  type="button"
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => {
                    onSelectPoll(p.id);
                    onClose();
                  }}
                  className={`w-full text-left p-4 rounded-xl border transition-colors flex items-center justify-between gap-3 ${
                    isActive
                      ? 'bg-stone-50 border-yellow-500 ring-1 ring-yellow-500'
                      : 'bg-white border-stone-200 hover:bg-stone-50'
                  }`}
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-stone-900 leading-tight">{p.title}</span>
                      {p.finalizedSlot ? (
                        <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold font-mono uppercase tracking-wider bg-green-500 text-white px-2 py-0.5 rounded-full">
                          <CheckCircle2 className="w-3 h-3" />
                          Agreed
                        </span>
                      ) : (
                        <span className="text-[11px] font-semibold font-mono uppercase tracking-wider bg-yellow-500 text-yellow-950 px-2 py-0.5 rounded-full">
                          Open
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-stone-500 font-medium">
                      <span className="inline-flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-stone-400" />
                        {dateRangeStr} ({p.dates.length} days)
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 text-stone-400" />
                        {p.durationMinutes}m
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Users className="w-3.5 h-3.5 text-stone-400" />
                        {p.participantsCount} responders
                      </span>
                    </div>
                  </div>

                  <ChevronRight
                    className={`w-5 h-5 shrink-0 ${isActive ? 'text-stone-700' : 'text-stone-300'}`}
                  />
                </button>
              );
            })}
          </div>

          <div className="mt-4 pt-4 border-t border-stone-200 flex items-center justify-between gap-3">
            <span className="text-xs text-stone-500">{polls.length} total polls</span>
            <button type="button" onClick={startNewPoll} className="edu-btn-primary">
              <Plus className="w-3.5 h-3.5" />
              Create Another Poll
            </button>
          </div>
        </>
      )}
    </Modal>
  );
};
