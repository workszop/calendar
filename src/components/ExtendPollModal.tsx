import React, { useEffect, useRef, useState } from 'react';
import type { Poll } from '../types';
import { formatDateHeading, toDateStr } from '../utils/calendar';
import { isValidHourWindow } from '../utils/consensus';
import { latestPollDate, MAX_POLL_DATES } from '../utils/limits';
import { useProposalDraft } from '../hooks/useProposalDraft';
import { Modal } from './Modal';
import { MonthCalendar, monthOfDateStr, startOfMonth } from './MonthCalendar';
import { ProposedTimesField } from './ProposedTimesField';

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
// The hour selects offer 6:00-22:00; a poll window outside that is clamped.
const MIN_GRID_HOUR = 6;
const MAX_GRID_HOUR = 22;

// ─── Helpers ───
function clampHour(h: number): number {
  return Math.min(MAX_GRID_HOUR, Math.max(MIN_GRID_HOUR, h));
}

// ─── Component ───
/** Adds candidate dates to an existing poll; existing dates and answers stay. */
export const ExtendPollModal: React.FC<ExtendPollModalProps> = ({ isOpen, onClose, poll, onAddDates }) => {
  const draft = useProposalDraft(clampHour(poll.startHour), clampHour(poll.endHour));
  const { selectedDates, startHour, endHour } = draft;
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(new Date()));
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const todayStr = toDateStr(new Date());

  // Fresh every open: the poll's own hours as the default range, month after
  // its last date so the next candidates are one click away.
  useEffect(() => {
    if (!isOpen) return;
    draft.reset(clampHour(poll.startHour), clampHour(poll.endHour));
    const lastDate = poll.dates[poll.dates.length - 1];
    setViewMonth(lastDate && lastDate > todayStr ? monthOfDateStr(lastDate) : startOfMonth(new Date()));
    setErrors({});
    setIsSubmitting(false);
  }, [isOpen, poll.id]);

  const handleClose = () => {
    if (isSubmitting) return;
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const dates = selectedDates.filter((d) => d >= todayStr && !poll.dates.includes(d));
    const nextErrors: FormErrors = {};
    if (dates.length === 0) nextErrors.dates = 'Select at least one new date.';
    else if (poll.dates.length + dates.length > MAX_POLL_DATES) {
      nextErrors.dates = `A poll can have at most ${MAX_POLL_DATES} dates.`;
    } else if (dates.some((d) => d > latestPollDate(new Date()))) {
      nextErrors.dates = 'Choose dates within the next year.';
    }
    if (!isValidHourWindow(startHour, endHour)) {
      nextErrors.hours = 'Start hour must be earlier than end hour.';
    } else {
      const emptyDay = draft.findEmptyDay(dates);
      if (emptyDay) nextErrors.hours = `${formatDateHeading(emptyDay).full}: propose at least one time.`;
    }
    draft.setDates(dates);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setIsSubmitting(true);
    try {
      await onAddDates(dates, draft.slotsFor(dates).proposedSlots);
      onClose();
    } catch (err) {
      console.error(err);
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
      panelClassName="max-w-2xl"
      initialFocusRef={cancelRef}
      dismissOnBackdrop={false}
    >
      <form onSubmit={handleSubmit} className="space-y-5" noValidate aria-busy={isSubmitting}>
        {errors.submit && (
          <div role="alert" className="bg-red-500 text-white rounded-xl px-4 py-3 text-xs font-semibold">
            {errors.submit}
          </div>
        )}

        <fieldset className="space-y-2">
          <legend className="edu-label">
            New dates ({selectedDates.length} selected){' '}
            <span className="text-stone-400 normal-case">(dates already in the poll are crossed out)</span>
          </legend>
          <MonthCalendar
            selected={selectedDates}
            onToggle={(date) => {
              setErrors((prev) => ({ ...prev, dates: undefined }));
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
            <p id="extend-dates-error" role="alert" className="text-xs text-red-700 mt-1">
              {errors.dates}
            </p>
          )}
        </fieldset>

        <ProposedTimesField
          draft={draft}
          idPrefix="extend"
          error={errors.hours}
          onEdit={() => errors.hours && setErrors((prev) => ({ ...prev, hours: undefined }))}
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
