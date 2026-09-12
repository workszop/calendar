import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Calendar as CalendarIcon,
  Clock,
  MapPin,
  Copy,
  Check,
  RotateCcw,
  ExternalLink,
  Download,
} from 'lucide-react';
import type { Poll } from '../types';
import {
  formatDateHeading,
  formatTimeSlot,
  generateGoogleCalendarUrl,
  generateOutlookUrl,
  downloadIcsFile,
} from '../utils/calendar';
import { ConfirmDialog } from './ConfirmDialog';
import { COPIED_LABEL_MS } from '../utils/constants';

// ─── Constants ───
/** White pill on the green block: the block itself carries the colour. */
const WHITE_PILL =
  'inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-white text-stone-700 text-xs font-bold transition-colors hover:bg-stone-100 disabled:opacity-50';

interface FinalizedBannerProps {
  poll: Poll;
  onResetFinalized: () => Promise<void>;
}

export const FinalizedBanner: React.FC<FinalizedBannerProps> = ({ poll, onResetFinalized }) => {
  const [copied, setCopied] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    []
  );

  const finalized = poll.finalizedSlot;
  if (!finalized) return null;

  const dateHeading = formatDateHeading(finalized.date);
  const startTime = formatTimeSlot(finalized.startTime);
  const endTime = formatTimeSlot(finalized.endTime);

  const handleCopyInviteText = async () => {
    const text = `📅 Meeting Confirmed: ${poll.title}
🗓️ ${dateHeading.full}
⏰ ${startTime} – ${endTime} (${poll.timezone})
📍 ${poll.location || 'Online'}
🔗 Meeting Details: ${window.location.href}`;

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_LABEL_MS);
    } catch {
      // Clipboard blocked (permission, insecure context): leave the label alone.
    }
  };

  const handleReset = async () => {
    setConfirmReopen(false);
    setIsResetting(true);
    try {
      await onResetFinalized();
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div id="finalized-meeting-banner" className="mb-6 bg-green-500 text-white rounded-2xl p-5 shadow-xs">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
        {/* Left info */}
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-white text-stone-900 text-xs font-bold rounded-full uppercase tracking-wider font-mono">
            <CheckCircle2 className="w-4 h-4" />
            Official Time Agreed & Confirmed
          </div>

          <h2 className="text-2xl font-bold text-white tracking-tight">{dateHeading.full}</h2>

          <div className="flex flex-wrap items-center gap-4 text-sm text-white/90 font-medium">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="w-4 h-4" />
              {startTime} – {endTime} ({poll.timezone})
            </span>
            {poll.location && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="w-4 h-4" />
                {poll.location}
              </span>
            )}
            <span className="text-xs text-white/75">Confirmed by {finalized.confirmedBy}</span>
          </div>
        </div>

        {/* Right action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <a
            id="google-cal-button"
            href={generateGoogleCalendarUrl(poll, finalized)}
            target="_blank"
            rel="noopener noreferrer"
            className={WHITE_PILL}
          >
            <CalendarIcon className="w-3.5 h-3.5" />
            Google Calendar
            <ExternalLink className="w-3 h-3 ml-0.5" />
          </a>

          <a
            id="outlook-cal-button"
            href={generateOutlookUrl(poll, finalized)}
            target="_blank"
            rel="noopener noreferrer"
            className={WHITE_PILL}
          >
            Outlook
            <ExternalLink className="w-3 h-3 ml-0.5" />
          </a>

          <button
            id="download-ics-button"
            type="button"
            onClick={() => downloadIcsFile(poll, finalized)}
            className={WHITE_PILL}
          >
            <Download className="w-3.5 h-3.5" />
            .ICS File
          </button>

          <button
            id="copy-invite-text-button"
            type="button"
            onClick={() => void handleCopyInviteText()}
            className={WHITE_PILL}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy Invite
              </>
            )}
          </button>
          <span role="status" className="sr-only">
            {copied ? 'Copied' : ''}
          </span>

          <button
            id="reopen-poll-button"
            type="button"
            onClick={() => setConfirmReopen(true)}
            disabled={isResetting}
            aria-label="Re-open voting"
            title="Re-open voting if plans changed"
            className="p-2 rounded-full text-white hover:bg-white/15 transition-colors disabled:opacity-50"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmReopen}
        title="Re-open voting?"
        message="The agreed meeting time will be unlocked and participants can vote again."
        confirmLabel="Re-open voting"
        danger
        onConfirm={() => void handleReset()}
        onCancel={() => setConfirmReopen(false)}
      />
    </div>
  );
};
