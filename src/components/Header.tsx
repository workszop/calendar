import type React from 'react';
import { Share2, Plus, ListFilter, CheckCircle2 } from 'lucide-react';
import type { Poll } from '../types';

interface HeaderProps {
  poll: Poll | null;
  onOpenNewPoll: () => void;
  onOpenShare: () => void;
  onOpenPollsList: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  poll,
  onOpenNewPoll,
  onOpenShare,
  onOpenPollsList,
}) => {
  return (
    <header className="edu-header">
      <div className="edu-header-inner md:justify-between">
        {/* Brand */}
        <div className="flex items-center gap-2">
          <img className="edu-logo" alt="edulab" src="/edulab-mark-ink.png" />
          <span className="edu-wordmark">edulab</span>
          {poll?.finalizedSlot && (
            <span className="ml-3 inline-flex items-center gap-1 text-[12px] font-bold font-mono uppercase tracking-wider text-white bg-green-500 px-2.5 py-1 rounded-full">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Time Agreed
            </span>
          )}
        </div>

        {/* Action Controls & Utilities */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Browse Polls Button */}
          <button id="browse-polls-button" type="button" onClick={onOpenPollsList} className="edu-btn-secondary">
            <ListFilter className="w-3.5 h-3.5" />
            All Polls
          </button>

          {/* Share Button */}
          {poll && (
            <button id="share-poll-button" type="button" onClick={onOpenShare} className="edu-btn-secondary">
              <Share2 className="w-3.5 h-3.5" />
              Share Link
            </button>
          )}

          {/* Create Poll Button */}
          <button id="create-new-poll-button" type="button" onClick={onOpenNewPoll} className="edu-btn-primary">
            <Plus className="w-3.5 h-3.5" />
            New Poll
          </button>
        </div>
      </div>
    </header>
  );
};
