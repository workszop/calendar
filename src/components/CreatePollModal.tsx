import React, { useEffect, useRef, useState } from 'react';
import type { Poll } from '../types';
import { formatDateHeading, toDateStr } from '../utils/calendar';
import { isValidHourWindow } from '../utils/consensus';
import { getStoredUser, setStoredUser } from '../utils/storage';
import { Modal } from './Modal';
import { MonthCalendar, monthOfDateStr, startOfMonth } from './MonthCalendar';
import { DRAFT_SLOT_INTERVAL, useProposalDraft } from '../hooks/useProposalDraft';
import { ProposedTimesField } from './ProposedTimesField';

// ─── Types ───
interface CreatePollModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreatePoll: (pollData: Partial<Poll>) => Promise<void>;
  defaultTimezone: string;
}

interface FormErrors {
  title?: string;
  dates?: string;
  hours?: string;
  submit?: string;
}

// ─── Constants ───
const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 17;

// ─── Helpers ───
function getNextDates(count: number, startOffset = 1): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + startOffset + i);
    return toDateStr(d);
  });
}

function getNextWeekDates(): string[] {
  // Next Monday through Friday
  const now = new Date();
  const daysUntilNextMonday = ((1 + 7 - now.getDay()) % 7) || 7;
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilNextMonday + i);
    return toDateStr(d);
  });
}

// ─── Component ───
export const CreatePollModal: React.FC<CreatePollModalProps> = ({
  isOpen,
  onClose,
  onCreatePoll,
  defaultTimezone,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('Google Meet');
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [creatorName, setCreatorName] = useState('');
  const [creatorEmail, setCreatorEmail] = useState('');
  const draft = useProposalDraft(DEFAULT_START_HOUR, DEFAULT_END_HOUR);
  const { selectedDates, startHour, endHour } = draft;
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(new Date()));
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  // A pending create must own the modal until it resolves. This covers the
  // close icon and Escape as well as the visible Cancel button; otherwise a
  // slow or failed request unmounts the form and hides its inline error.
  const handleClose = () => {
    if (isSubmitting) return;
    onClose();
  };

  const todayStr = toDateStr(new Date());

  // A fresh draft every time the modal opens, so nothing leaks between polls.
  useEffect(() => {
    if (!isOpen) return;
    const stored = getStoredUser();
    setTitle('');
    setDescription('');
    setLocation('Google Meet');
    setDurationMinutes(60);
    setCreatorName(stored.name);
    setCreatorEmail(stored.email);
    // No dates are preselected: the organizer picks them (or uses a preset).
    draft.reset(DEFAULT_START_HOUR, DEFAULT_END_HOUR);
    setViewMonth(startOfMonth(new Date()));
    setErrors({});
    setIsSubmitting(false);
  }, [isOpen]);

  const toggleDate = (dateStr: string) => {
    setErrors((prev) => ({ ...prev, dates: undefined }));
    draft.toggleDate(dateStr);
  };

  const applyPreset = (dates: string[]) => {
    draft.setDates(dates);
    setErrors((prev) => ({ ...prev, dates: undefined }));
    if (dates[0]) setViewMonth(monthOfDateStr(dates[0]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Past days may still sit in the selection if the modal stayed open past midnight.
    const dates = selectedDates.filter((d) => d >= todayStr);
    const nextErrors: FormErrors = {};

    if (!title.trim()) nextErrors.title = 'Give the meeting a title.';
    if (dates.length === 0) nextErrors.dates = 'Select at least one candidate date.';
    if (!isValidHourWindow(startHour, endHour)) {
      nextErrors.hours = 'Start hour must be earlier than end hour.';
    } else {
      const emptyDay = draft.findEmptyDay(dates);
      if (emptyDay) {
        nextErrors.hours = `${formatDateHeading(emptyDay).full}: propose at least one time.`;
      }
    }

    draft.setDates(dates);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    // A plain hour window is sent when every day proposes the full range.
    const { proposedSlots, isFullRange } = draft.slotsFor(dates);

    setIsSubmitting(true);
    // Both fields are optional: leaving one blank must not wipe a stored value.
    setStoredUser({
      name: creatorName.trim() || undefined,
      email: creatorEmail.trim() || undefined,
    });

    try {
      await onCreatePoll({
        title: title.trim(),
        description: description.trim(),
        location: location.trim(),
        durationMinutes,
        startHour,
        endHour,
        proposedSlots: isFullRange ? undefined : proposedSlots,
        slotInterval: DRAFT_SLOT_INTERVAL,
        dates,
        creatorName: creatorName.trim() || 'Organizer',
        creatorEmail: creatorEmail.trim(),
        timezone: defaultTimezone,
      });
      onClose();
    } catch (err) {
      console.error(err);
      setErrors({ submit: 'Failed to create the meeting poll. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Create New Meeting Poll"
      subtitle="Invite your team or group to vote and find the best meeting time."
      panelClassName="max-w-2xl"
      initialFocusRef={titleInputRef}
      dismissOnBackdrop={false}
    >
      <form onSubmit={handleSubmit} className="space-y-5" noValidate aria-busy={isSubmitting}>
        {errors.submit && (
          <div role="alert" className="bg-red-500 text-white rounded-xl px-4 py-3 text-xs font-semibold">
            {errors.submit}
          </div>
        )}

        {/* Title */}
        <div>
          <label htmlFor="poll-title-input" className="edu-label">
            Meeting Title <span className="text-stone-400 normal-case">(required)</span>
          </label>
          <input
            id="poll-title-input"
            ref={titleInputRef}
            type="text"
            aria-required="true"
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? 'poll-title-error' : undefined}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (errors.title) setErrors((prev) => ({ ...prev, title: undefined }));
            }}
            placeholder="e.g. Q4 Strategy and Roadmap Alignment"
            className={`edu-input ${errors.title ? 'border-red-400' : ''}`}
          />
          {errors.title && (
            <p id="poll-title-error" role="alert" className="text-xs text-red-700 mt-1">
              {errors.title}
            </p>
          )}
        </div>

        {/* Description and location */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="poll-location-input" className="edu-label">
              Location / Video Call
            </label>
            <input
              id="poll-location-input"
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Google Meet, Zoom, Room 3A"
              className="edu-input"
            />
          </div>

          <div>
            <label htmlFor="poll-duration-select" className="edu-label">
              Meeting Duration
            </label>
            <select
              id="poll-duration-select"
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
              className="edu-input"
            >
              <option value={15}>15 Minutes</option>
              <option value={30}>30 Minutes</option>
              <option value={45}>45 Minutes</option>
              <option value={60}>1 Hour</option>
              <option value={90}>1.5 Hours</option>
              <option value={120}>2 Hours</option>
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="poll-description-input" className="edu-label">
            Agenda or Notes (Optional)
          </label>
          <textarea
            id="poll-description-input"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this meeting about? Any prep required?"
            className="edu-input"
          />
        </div>

        {/* Candidate dates */}
        <fieldset className="space-y-2">
          <legend className="edu-label">
            Proposed dates ({selectedDates.length} selected){' '}
            <span className="text-stone-400 normal-case">(required)</span>
          </legend>
          <div className="flex items-center justify-end gap-2 text-xs flex-wrap">
            <button
              type="button"
              onClick={() => applyPreset(getNextDates(3))}
              className="font-semibold text-stone-600 hover:text-stone-900 underline underline-offset-2 transition-colors"
            >
              Next 3 Days
            </button>
            <span className="text-stone-300">/</span>
            <button
              type="button"
              onClick={() => applyPreset(getNextWeekDates())}
              className="font-semibold text-stone-600 hover:text-stone-900 underline underline-offset-2 transition-colors"
            >
              Next Week (Mon-Fri)
            </button>
          </div>

          <MonthCalendar
            selected={selectedDates}
            onToggle={toggleDate}
            minDate={todayStr}
            viewMonth={viewMonth}
            onViewMonthChange={setViewMonth}
            invalid={Boolean(errors.dates)}
            describedBy={errors.dates ? 'poll-dates-error' : undefined}
          />
          {errors.dates && (
            <p id="poll-dates-error" role="alert" className="text-xs text-red-700 mt-1">
              {errors.dates}
            </p>
          )}
        </fieldset>

        {/* Proposed times: hour range, then drag to fine-tune each day */}
        <ProposedTimesField
          draft={draft}
          idPrefix="poll"
          error={errors.hours}
          onEdit={() => errors.hours && setErrors((prev) => ({ ...prev, hours: undefined }))}
        />

        {/* Organizer */}
        <div className="pt-2 border-t border-stone-200 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="poll-creator-name" className="edu-label">
              Your Name (Organizer)
            </label>
            <input
              id="poll-creator-name"
              type="text"
              value={creatorName}
              onChange={(e) => setCreatorName(e.target.value)}
              placeholder="e.g. Sarah Chen"
              className="edu-input"
            />
          </div>

          <div>
            <label htmlFor="poll-creator-email" className="edu-label">
              Your Email (Optional)
            </label>
            <input
              id="poll-creator-email"
              type="email"
              value={creatorEmail}
              onChange={(e) => setCreatorEmail(e.target.value)}
              placeholder="sarah@company.com"
              className="edu-input"
            />
          </div>
        </div>

        {/* Footer actions */}
        <div className="pt-4 border-t border-stone-200 flex items-center justify-end gap-2">
          <button type="button" onClick={handleClose} disabled={isSubmitting} className="edu-btn-secondary">
            Cancel
          </button>
          <button
            type="submit"
            id="create-poll-submit-btn"
            disabled={isSubmitting}
            className="edu-btn-primary"
          >
            {isSubmitting ? 'Creating...' : 'Create Meeting Poll'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
