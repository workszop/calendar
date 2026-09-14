import React, { useEffect, useRef, useState } from 'react';
import type { Poll } from '../types';
import { toDateStr } from '../utils/calendar';
import { Modal } from './Modal';
import { MonthCalendar, monthOfDateStr, startOfMonth } from './MonthCalendar';
import { ProposedTimesField } from './ProposedTimesField';
import './create-poll.css';
import {
  buildCreatePollPayload,
  getNextDates,
  getNextWeekDates,
  rememberCreatePollOrganizer,
  type CreatePollFormErrors,
  useCreatePollForm,
  validateCreatePoll,
} from './create-poll-form';

// ─── Types ───
interface CreatePollModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreatePoll: (pollData: Partial<Poll>) => Promise<void>;
  defaultTimezone: string;
}

// ─── Component ───
export const CreatePollModal: React.FC<CreatePollModalProps> = ({
  isOpen,
  onClose,
  onCreatePoll,
  defaultTimezone,
}) => {
  const form = useCreatePollForm('Google Meet');
  const { title, description, location, durationMinutes, creatorName, creatorEmail, draft } = form;
  const { selectedDates } = draft;
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(new Date()));
  const [errors, setErrors] = useState<CreatePollFormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitGuardRef = useRef(false);
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
    // No dates are preselected: the organizer picks them (or uses a preset).
    form.reset({ location: 'Google Meet' });
    setViewMonth(startOfMonth(new Date()));
    setErrors({});
    setIsSubmitting(false);
    submitGuardRef.current = false;
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

    if (isSubmitting || submitGuardRef.current) return;

    const { dates, errors: nextErrors } = validateCreatePoll({ title, draft }, todayStr);

    draft.setDates(dates);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    submitGuardRef.current = true;
    setIsSubmitting(true);
    rememberCreatePollOrganizer({ creatorName, creatorEmail });

    try {
      await onCreatePoll(buildCreatePollPayload(form, dates, defaultTimezone));
      onClose();
    } catch (err) {
      console.error(err);
      setErrors({
        submit:
          err instanceof Error && err.message
            ? err.message
            : 'Failed to create the meeting poll. Please try again.',
      });
    } finally {
      submitGuardRef.current = false;
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
      <form
        onSubmit={handleSubmit}
        className="space-y-5"
        noValidate
        aria-busy={isSubmitting}
        data-create-form="true"
        data-selection-count={selectedDates.length}
        data-save-state={isSubmitting ? 'saving' : errors.submit ? 'error' : 'idle'}
      >
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
              form.setTitle(e.target.value);
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
              onChange={(e) => form.setLocation(e.target.value)}
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
              onChange={(e) => form.setDurationMinutes(Number(e.target.value))}
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
            onChange={(e) => form.setDescription(e.target.value)}
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
              onChange={(e) => form.setCreatorName(e.target.value)}
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
              onChange={(e) => form.setCreatorEmail(e.target.value)}
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
