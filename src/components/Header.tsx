import React from 'react';
import { ArrowLeft, CheckCircle2, Share2 } from 'lucide-react';
import type { Poll } from '../types';
import './home-page.css';

// ─── Types ───

export type HeaderScreen = 'home' | 'workspace' | 'create' | 'created';

interface HeaderProps {
  poll: Poll | null;
  screen?: HeaderScreen;
  onOpenShare?: () => void;
  onGoHome: () => void;
  isBusy?: boolean;
}

// ─── Component ───

export const Header: React.FC<HeaderProps> = ({
  poll,
  screen = 'workspace',
  onOpenShare,
  onGoHome,
  isBusy = false,
}) => {
  const showBack = screen !== 'home';

  // A real link keeps middle-click and "open in new tab" useful. A primary
  // click stays inside the SPA and is guarded while a create request is live.
  const handleHomeClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!isBusy) onGoHome();
  };

  return (
    <header className="edu-header d-shell-header">
      <div className="edu-header-inner d-shell-header-inner">
        <div className="d-shell-header-left">
          <a
            id="brand-home-link"
            href="/"
            onClick={handleHomeClick}
            aria-label="edulab, home"
            aria-disabled={isBusy ? 'true' : undefined}
            className="d-shell-brand"
          >
            <img className="edu-logo" alt="" src="/edulab-mark-ink.png" />
            <span className="edu-wordmark">edulab</span>
          </a>
          <span className="d-shell-context">Meeting scheduler</span>
          {poll?.finalizedSlot && (
            <span className="d-shell-agreed">
              <CheckCircle2 aria-hidden="true" />
              Time agreed
            </span>
          )}
        </div>

        {showBack && (
          <div className="d-shell-header-actions">
            <button
              id="header-home"
              type="button"
              className="edu-btn-ghost d-shell-back"
              onClick={onGoHome}
              disabled={isBusy}
            >
              <ArrowLeft aria-hidden="true" />
              All meetings
            </button>
            {screen === 'workspace' && poll && onOpenShare && (
              <button
                id="share-poll-button"
                type="button"
                className="edu-btn-secondary d-shell-share"
                onClick={onOpenShare}
              >
                <Share2 aria-hidden="true" />
                Share link
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
};
