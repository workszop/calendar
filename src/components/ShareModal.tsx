import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check, Share2, Mail } from 'lucide-react';
import type { Poll } from '../types';
import { formatDateHeading } from '../utils/calendar';
import { Modal } from './Modal';
import { COPIED_LABEL_MS } from '../utils/constants';

// ─── Types ───
interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  poll: Poll;
}

// ─── Component ───
export const ShareModal: React.FC<ShareModalProps> = ({ isOpen, onClose, poll }) => {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [copyError, setCopyError] = useState<'link' | 'text' | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  // Pending "Copied" label resets, cleared whenever the modal closes or unmounts.
  const resetTimers = useRef<number[]>([]);

  const clearResetTimers = useCallback(() => {
    resetTimers.current.forEach((id) => window.clearTimeout(id));
    resetTimers.current = [];
  }, []);

  const scheduleReset = (fn: () => void) => {
    resetTimers.current.push(window.setTimeout(fn, COPIED_LABEL_MS));
  };

  // Nothing sticky between openings, and no "Copied" timer outliving the modal:
  // the cleanup covers both closing and unmounting.
  useEffect(() => {
    if (!isOpen) return;
    setCopiedLink(false);
    setCopiedText(false);
    setCopyError(null);
    setAnnouncement('');
    return clearResetTimers;
  }, [isOpen, clearResetTimers]);

  const shareUrl = `${window.location.origin}${window.location.pathname}?poll=${poll.id}`;

  const dateList = poll.dates.map((d) => formatDateHeading(d).full).join(', ');
  const inviteMessage = `Hi everyone, please submit your availability for "${poll.title}" (${poll.durationMinutes} min) so we can agree on a time that works for all of us!

Dates considered: ${dateList}
Vote here: ${shareUrl}`;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyError(null);
      setCopiedLink(true);
      setAnnouncement('Copied');
      scheduleReset(() => setCopiedLink(false));
    } catch {
      setCopiedLink(false);
      setCopyError('link');
      setAnnouncement('Copy failed');
      linkInputRef.current?.select();
    }
  };

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(inviteMessage);
      setCopyError(null);
      setCopiedText(true);
      setAnnouncement('Copied template');
      scheduleReset(() => setCopiedText(false));
    } catch {
      setCopiedText(false);
      setCopyError('text');
      setAnnouncement('Copy failed');
    }
  };

  const handleEmailInvite = () => {
    const subject = encodeURIComponent(`Availability for: ${poll.title}`);
    const body = encodeURIComponent(inviteMessage);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Share Meeting Poll"
      subtitle="Send the link so everyone can vote on a time."
      titleIcon={<Share2 className="w-5 h-5 text-stone-500 mt-0.5 shrink-0" />}
    >
      <div className="space-y-4">
        <p role="status" className="sr-only">
          {announcement}
        </p>

        {/* Direct link */}
        <div>
          <label htmlFor="share-link-input" className="edu-label">
            Poll Link
          </label>
          <div className="flex items-center gap-2">
            <input
              id="share-link-input"
              ref={linkInputRef}
              type="text"
              readOnly
              value={shareUrl}
              className="edu-input text-xs font-mono select-all"
            />
            <button
              type="button"
              id="copy-poll-link-btn"
              onClick={handleCopyLink}
              className="edu-btn-primary shrink-0"
            >
              {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedLink ? 'Copied' : 'Copy'}
            </button>
          </div>
          {copyError === 'link' && (
            <p role="alert" className="text-xs text-red-700 mt-1">
              Copy failed - select and copy manually
            </p>
          )}
        </div>

        {/* Invitation template */}
        <div>
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="share-template-textarea" className="edu-label">
              Slack / Email Invitation Template
            </label>
            <button
              type="button"
              id="copy-formatted-text-btn"
              onClick={handleCopyText}
              className="edu-btn-ghost shrink-0"
            >
              {copiedText ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copiedText ? 'Copied template' : 'Copy template'}
            </button>
          </div>
          <textarea
            id="share-template-textarea"
            readOnly
            rows={4}
            value={inviteMessage}
            className="edu-input text-xs select-all resize-none leading-relaxed"
          />
          {copyError === 'text' && (
            <p role="alert" className="text-xs text-red-700 mt-1">
              Copy failed - select and copy manually
            </p>
          )}
        </div>

        {/* Quick actions */}
        <div className="pt-2">
          <button
            type="button"
            id="send-email-invite-btn"
            onClick={handleEmailInvite}
            className="w-full inline-flex items-center justify-center gap-2 px-3.5 py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-semibold rounded-xl transition-colors"
          >
            <Mail className="w-4 h-4 text-stone-600" />
            Open in Default Email App
          </button>
        </div>
      </div>
    </Modal>
  );
};
