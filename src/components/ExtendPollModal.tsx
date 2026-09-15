import React, { useEffect, useRef, useState } from 'react';
import type { Poll } from '../types';
import { toDateStr } from '../utils/calendar';
import { isValidHourWindow } from '../utils/consensus';
import { latestPollDate, MAX_POLL_DATES } from '../utils/limits';
import { useProposalDraft } from '../hooks/useProposalDraft';
import { Modal } from './Modal';
import { MonthCalendar, monthOfDateStr, startOfMonth } from './MonthCalendar';
import { DayTimesEditor } from './DayTimesEditor';
import { proposalHoursError } from './create-poll-form';

// ─── Types ───
interface ExtendPollModalProps {
  isOpen: boolean;
  onClose: () => void;
  poll: Poll;
  onAddDates: (dates: string[], proposedSlots: Record<string, string[]>) => Promise<void>;
}

interface FormErrors {
  dates?: string;
  hours?: string;
  submit?: string;
}

// ─── Constants ───
// Used only when the poll's own window is unusable; the editor can widen to 0-24.
const FALLBACK_START_HOUR = 9;
const FALLBACK_END_HOUR = 17;

// ─── Helpers ───
function initialRange(poll: Poll): [number, number] {
  return isValidHourWindow(poll.startHour, poll.endHour)
    ? [poll.startHour, poll.endHour]
    : [FALLBACK_START_HOUR, FALLBACK_END_HOUR];
}

// ─── Component ───
/** Adds candidate dates to an existing poll; existing dates and answers stay. */
export const ExtendPollModal: React.FC<ExtendPollModalProps> = ({ isOpen, onClose, poll, onAddDates }) => {
  // New days start empty, like poll creation, so every proposal is deliberate.
  // The grid steps at the poll's own interval: its meeting fit is judged at
  // that interval, so a 15-minute poll needs 15-minute proposals.
  const draft = useProposalDraft(...initialRange(poll), true, poll.slotInterval);
  const { selectedDates } = draft;
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(new Date()));
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dateErrorRef = useRef<HTMLParagraphElement | null>(null);
  const submitErrorRef = useRef<HTMLDivElement | null>(null);
  // Move focus to the first error only right after a submit, as the create page
  // does: clearing one error while fixing another must not pull focus away.
  const focusErrorsRef = useRef(false);

  const todayStr = toDateStr(new Date());

  // Fresh every open: the poll's own hours as the default range, month after
  // its last date so the next candidates are one click away.
  useEffect(() => {
    if (!isOpen) return;
    draft.reset(...initialRange(poll));
    const lastDate = poll.dates[poll.dates.length - 1];
    setViewMonth(lastDate && lastDate > todayStr ? monthOfDateStr(lastDate) : startOfMonth(new Date()));
    setErrors({});
    setIsSubmitting(false);
  }, [isOpen, poll.id]);

  useEffect(() => {
    if (!focusErrorsRef.current) return;
    focusErrorsRef.current = false;
    if (errors.submit) submitErrorRef.current?.focus();
    else if (errors.dates) dateErrorRef.current?.focus();
    else if (errors.hours) document.getElementById('extend-start-hour')?.focus();
  }, [errors]);

  const handleClose = () => {
    if (isSubmitting) return;
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    const dates = selectedDates.filter((d) => d >= todayStr && !poll.dates.includes(d));
    const { proposedSlots } = draft.slotsFor(dates);
    const nextErrors: FormErrors = {};
    if (dates.length === 0) nextErrors.dates = 'Select at least one new date.';
    else if (poll.dates.length + dates.length > MAX_POLL_DATES) {
      nextErrors.dates = `A poll can have at most ${MAX_POLL_DATES} dates.`;
    } else if (dates.some((d) => d > latestPollDate(new Date()))) {
      nextErrors.dates = 'Choose dates within the next year.';
    }
    const hours = proposalHoursError(draft, dates, poll.durationMinutes);
    if (hours) nextErrors.hours = hours;
    draft.setDates(dates);
    focusErrorsRef.current = true;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setIsSubmitting(true);
    try {
      await onAddDates(dates, proposedSlots);
      onClose();
    } catch (err) {
      console.error(err);
      focusErrorsRef.current = true;
      setErrors({
        submit: err instanceof Error && err.message ? err.message : 'Could not add the dates. Please try again.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Add Dates"
      subtitle={`Propose more dates for "${poll.title}". Existing dates and answers stay as they are.`}
      panelClassName="max-w-4xl"
      initialFocusRef={cancelRef}
      dismissOnBackdrop={false}
    >
      <form onSubmit={handleSubmit} className="space-y-5" noValidate aria-busy={isSubmitting}>
        {errors.submit && (
          <div ref={submitErrorRef} role="alert" tabIndex={-1} data-extend-error="submit" className="bg-red-500 text-white rounded-xl px-4 py-3 text-xs font-semibold">
            {errors.submit}
          </div>
        )}

        <fieldset className="space-y-2" disabled={isSubmitting}>
          <legend className="edu-label">
            New dates ({selectedDates.length} selected){' '}
            <span className="text-stone-400 normal-case">(dates already in the poll are crossed out)</span>
          </legend>
          <MonthCalendar
            selected={selectedDates}
            onToggle={(date) => {
              setErrors((prev) => ({ ...prev, dates: undefined, hours: undefined }));
              draft.toggleDate(date);
            }}
            minDate={todayStr}
            viewMonth={viewMonth}
            onViewMonthChange={setViewMonth}
            lockedDates={poll.dates}
            invalid={Boolean(errors.dates)}
            describedBy={errors.dates ? 'extend-dates-error' : undefined}
          />
          {errors.dates && (
            <p ref={dateErrorRef} id="extend-dates-error" role="alert" tabIndex={-1} className="text-xs text-red-700 mt-1">
              {errors.dates}
            </p>
          )}
        </fieldset>

        <DayTimesEditor
          draft={draft}
          idPrefix="extend"
          error={errors.hours}
          onEdit={() => errors.hours && setErrors((prev) => ({ ...prev, hours: undefined }))}
          disabled={isSubmitting}
        />

        <div className="pt-4 border-t border-stone-200 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            className="edu-btn-secondary"
          >
            Cancel
          </button>
          <button type="submit" id="add-dates-submit-btn" disabled={isSubmitting} className="edu-btn-primary">
            {isSubmitting
              ? 'Adding...'
              : selectedDates.length === 0
                ? 'Add Dates'
                : selectedDates.length === 1
                  ? 'Add 1 Date'
                  : `Add ${selectedDates.length} Dates`}
          </button>
        </div>
      </form>
    </Modal>
  );
};
