import React, { useEffect, useRef, useState } from 'react';
import { CalendarDays, Clock3, Type } from 'lucide-react';
import type { Poll } from '../types';
import { formatDateHeading, toDateStr } from '../utils/calendar';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_LOCATION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_TITLE_LENGTH,
} from '../utils/limits';
import { MonthCalendar, monthOfDateStr, startOfMonth } from './MonthCalendar';
import { DayTimesEditor } from './DayTimesEditor';
import { ActionDock } from './ActionDock';
import {
  buildCreatePollPayload,
  CREATE_POLL_DURATIONS,
  getNextDates,
  getNextWeekDates,
  rememberCreatePollOrganizer,
  type CreatePollFormErrors,
  useCreatePollForm,
  validateCreatePoll,
} from './create-poll-form';
import './create-poll.css';

// ─── Types ───
export interface CreatePollPageProps {
  onCancel: () => void;
  onCreatePoll: (data: Partial<Poll>) => Promise<void>;
  defaultTimezone: string;
  onBusyChange?: (busy: boolean) => void;
}

// ─── Component ───
/** Single-view poll creation form. Every required choice stays in one form. */
export const CreatePollPage: React.FC<CreatePollPageProps> = ({
  onCancel,
  onCreatePoll,
  defaultTimezone,
  onBusyChange,
}) => {
  // The page starts with dates that are deliberately empty. A selected day is
  // only proposed after the organizer paints it in the direct editor.
  const form = useCreatePollForm('', true);
  const { title, description, location, durationMinutes, creatorName, creatorEmail, draft } = form;
  const { selectedDates } = draft;
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(new Date()));
  const [errors, setErrors] = useState<CreatePollFormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitGuardRef = useRef(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const dateErrorRef = useRef<HTMLParagraphElement | null>(null);
  const submitErrorRef = useRef<HTMLDivElement | null>(null);

  const todayStr = toDateStr(new Date());

  // Inform the app immediately, including on a slow or rejected request.
  const setBusy = (busy: boolean) => {
    setIsSubmitting(busy);
    onBusyChange?.(busy);
  };

  // Move focus to the first actionable error, only right after a submit: clearing
  // one error while the user fixes another must not pull focus away.
  const focusErrorsRef = useRef(false);
  useEffect(() => {
    if (!focusErrorsRef.current) return;
    focusErrorsRef.current = false;
    if (errors.submit) {
      submitErrorRef.current?.focus();
      return;
    }
    if (errors.title) {
      titleInputRef.current?.focus();
      return;
    }
    if (errors.dates) {
      dateErrorRef.current?.focus();
      return;
    }
    if (errors.hours) {
      document.getElementById('create-page-start-hour')?.focus();
    }
  }, [errors]);

  const clearError = (key: keyof CreatePollFormErrors) => {
    if (!errors[key]) return;
    setErrors((previous) => ({ ...previous, [key]: undefined }));
  };

  const handleTitleChange = (value: string) => {
    form.setTitle(value);
    clearError('title');
    clearError('submit');
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting || submitGuardRef.current) return;

    const validation = validateCreatePoll({ title, draft, durationMinutes }, todayStr);
    // Keep only future dates in the draft before either displaying errors or
    // constructing the payload. setDates preserves every existing proposal.
    draft.setDates(validation.dates);
    focusErrorsRef.current = true;
    setErrors(validation.errors);
    if (Object.keys(validation.errors).length > 0) return;

    // State updates are batched, so the ref closes the tiny window in which a
    // second submit event could arrive before the disabled attribute renders.
    submitGuardRef.current = true;
    setBusy(true);
    rememberCreatePollOrganizer({ creatorName, creatorEmail });

    try {
      await onCreatePoll(buildCreatePollPayload(form, validation.dates, defaultTimezone));
      // The app owns the success/share-ready transition. Do not call onCancel
      // here: it would navigate away from that transition on a successful POST.
    } catch (error) {
      console.error(error);
      focusErrorsRef.current = true;
      setErrors({
        submit:
          error instanceof Error && error.message
            ? error.message
            : 'Failed to create the meeting poll. Please try again.',
      });
    } finally {
      submitGuardRef.current = false;
      setBusy(false);
    }
  };

  const toggleDate = (date: string) => {
    draft.toggleDate(date);
    clearError('dates');
    clearError('hours');
    clearError('submit');
  };

  const applyPreset = (dates: string[]) => {
    draft.setDates(dates);
    if (dates[0]) setViewMonth(monthOfDateStr(dates[0]));
    clearError('dates');
    clearError('hours');
    clearError('submit');
  };

  return (
    <section
      className="d-create-page"
      data-screen="create"
      data-busy={isSubmitting ? 'true' : 'false'}
      data-selection-count={selectedDates.length}
      data-selected-dates={selectedDates.join(',')}
      data-save-state={isSubmitting ? 'saving' : errors.submit ? 'error' : 'idle'}
      aria-busy={isSubmitting}
    >
      <header className="d-create-header">
        <div className="d-create-header-copy">
          <h1>Create a meeting poll</h1>
          <p className="d-create-lead">
            Set up a few possible times, then share one simple link with your group.
          </p>
        </div>
      </header>

      <div className="d-create-layout">
        <form
          className="d-create-form"
          noValidate
          aria-busy={isSubmitting}
          onSubmit={handleSubmit}
        >
          {errors.submit && (
            <div
              ref={submitErrorRef}
              role="alert"
              tabIndex={-1}
              className="d-create-alert"
            >
              {errors.submit}
            </div>
          )}

          <div className="d-create-top-grid">
            <section
              className="d-create-details-panel"
              data-visual-group="meeting-details"
              aria-label="Meeting details"
            >
              <div className="d-create-field-stack">
                <label htmlFor="create-page-title" className="d-create-label">
                  <span className="d-create-label-copy">
                    <Type
                      className="d-create-inline-icon"
                      data-visual-icon="title"
                      aria-hidden="true"
                    />
                    <span>
                      Meeting name <span className="d-create-required">(required)</span>
                    </span>
                  </span>
                  <input
                    id="create-page-title"
                    ref={titleInputRef}
                    type="text"
                    value={title}
                    maxLength={MAX_TITLE_LENGTH}
                    placeholder="e.g. Workshop planning"
                    aria-required="true"
                    aria-invalid={errors.title ? true : undefined}
                    aria-describedby={errors.title ? 'create-page-title-error' : undefined}
                    className={`edu-input d-create-title-input${errors.title ? ' border-red-400' : ''}`}
                    onChange={(event) => handleTitleChange(event.target.value)}
                  />
                  {errors.title && (
                    <span id="create-page-title-error" role="alert" className="d-create-error">
                      {errors.title}
                    </span>
                  )}
                </label>

                <fieldset>
                  <legend>
                    <Clock3
                      className="d-create-inline-icon"
                      data-visual-icon="clock"
                      aria-hidden="true"
                    />
                    <span>Meeting duration</span>
                  </legend>
                  <div className="d-create-duration-options">
                    {CREATE_POLL_DURATIONS.map((minutes) => (
                      <button
                        key={minutes}
                        type="button"
                        aria-pressed={durationMinutes === minutes}
                        aria-label={`${minutes} minutes`}
                        disabled={isSubmitting}
                        onClick={() => {
                          form.setDurationMinutes(minutes);
                          // A shorter meeting can resolve a meeting-length error.
                          clearError('hours');
                        }}
                      >
                        {minutes} min
                      </button>
                    ))}
                  </div>
                  <p className="d-create-hint">
                    This is the meeting length, not the calendar cell size.
                  </p>
                </fieldset>

              </div>
            </section>

            <section
              className="d-create-date-panel"
              data-visual-group="date-selection"
              aria-labelledby="create-dates-heading"
            >
              <div className="d-create-section-heading-row">
                <h2 id="create-dates-heading" className="d-create-section-heading">
                  <CalendarDays
                    className="d-create-section-icon d-create-section-icon--blue"
                    data-visual-icon="calendar"
                    aria-hidden="true"
                  />
                  <span>Candidate dates</span>
                </h2>
                <span className="d-create-required">(required)</span>
              </div>
              <p className="d-create-form-intro">
                Select the days that could work for your group.
              </p>

              <fieldset disabled={isSubmitting}>
                <legend className="sr-only">Candidate dates</legend>
                <MonthCalendar
                  responsive
                  selected={selectedDates}
                  onToggle={toggleDate}
                  minDate={todayStr}
                  viewMonth={viewMonth}
                  onViewMonthChange={setViewMonth}
                  invalid={Boolean(errors.dates)}
                  describedBy={errors.dates ? 'create-page-dates-error' : undefined}
                />
                <div className="d-create-date-presets">
                  <button type="button" onClick={() => applyPreset(getNextDates(3))}>
                    Next 3 Days
                  </button>
                  <button type="button" onClick={() => applyPreset(getNextWeekDates())}>
                    Next Week (Mon-Fri)
                  </button>
                </div>
                <p className="d-create-selection-count" data-date-count={selectedDates.length}>
                  {selectedDates.length
                    ? `${selectedDates.length} date${selectedDates.length === 1 ? '' : 's'} selected`
                    : 'No dates selected yet'}
                </p>
                <div className="d-create-selected-days" aria-label="Selected dates">
                  {selectedDates.map((date) => (
                    <button
                      key={date}
                      type="button"
                      className="d-create-selected-day"
                      aria-label={`Remove ${formatDateHeading(date).full}`}
                      onClick={() => toggleDate(date)}
                    >
                      {formatDateHeading(date).dayMonth} ×
                    </button>
                  ))}
                </div>
                {errors.dates && (
                  <p
                    ref={dateErrorRef}
                    id="create-page-dates-error"
                    role="alert"
                    tabIndex={-1}
                    className="d-create-error"
                  >
                    {errors.dates}
                  </p>
                )}
              </fieldset>
            </section>
          </div>

          <section
            className="d-create-times-section"
            data-visual-group="time-selection"
            aria-labelledby="create-times-heading"
          >
            <div className="d-create-times-heading-row">
              <div>
                <h2 id="create-times-heading" className="d-create-section-heading">
                  Proposed times
                </h2>
                <p className="d-create-form-intro">
                  Paint the available blocks for each selected day. Different days can have
                  different hours.
                </p>
              </div>
              <p className="d-create-timezone">Timezone: {defaultTimezone}</p>
            </div>
            <DayTimesEditor
              draft={draft}
              idPrefix="create-page"
              error={errors.hours}
              onEdit={() => {
                clearError('hours');
                clearError('submit');
              }}
              disabled={isSubmitting}
            />
          </section>

          <details className="d-create-optional d-create-optional-wide">
            <summary>Add location, notes or organizer details (optional)</summary>
            <div className="d-create-optional-grid">
              <label htmlFor="create-page-location">
                Location <span className="d-create-optional-label">(optional)</span>
                <input
                  id="create-page-location"
                  type="text"
                  value={location}
                  maxLength={MAX_LOCATION_LENGTH}
                  placeholder="Online, or a meeting room"
                  className="edu-input"
                  disabled={isSubmitting}
                  onChange={(event) => form.setLocation(event.target.value)}
                />
              </label>
              <label htmlFor="create-page-organizer-name">
                Your name <span className="d-create-optional-label">(optional)</span>
                <input
                  id="create-page-organizer-name"
                  type="text"
                  value={creatorName}
                  maxLength={MAX_NAME_LENGTH}
                  placeholder="How should people know you?"
                  className="edu-input"
                  disabled={isSubmitting}
                  onChange={(event) => form.setCreatorName(event.target.value)}
                />
              </label>
              <label htmlFor="create-page-description" className="d-create-wide">
                Notes <span className="d-create-optional-label">(optional)</span>
                <textarea
                  id="create-page-description"
                  rows={3}
                  value={description}
                  maxLength={MAX_DESCRIPTION_LENGTH}
                  placeholder="What should people prepare?"
                  className="edu-input"
                  disabled={isSubmitting}
                  onChange={(event) => form.setDescription(event.target.value)}
                />
              </label>
              <label htmlFor="create-page-organizer-email" className="d-create-wide">
                Your email <span className="d-create-optional-label">(optional)</span>
                <input
                  id="create-page-organizer-email"
                  type="email"
                  value={creatorEmail}
                  maxLength={MAX_EMAIL_LENGTH}
                  placeholder="you@example.com"
                  className="edu-input"
                  disabled={isSubmitting}
                  onChange={(event) => form.setCreatorEmail(event.target.value)}
                />
              </label>
            </div>
          </details>

          <ActionDock label="Create poll actions" className="d-create-form-footer">
            <button
              type="button"
              className="d-create-secondary"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              Back to meetings
            </button>
            <div className="d-create-form-footer-actions">
              <button
                type="submit"
                className="d-create-primary"
                data-primary-action
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Creating...' : 'Create poll'}
              </button>
            </div>
          </ActionDock>
        </form>
      </div>
    </section>
  );
};

export default CreatePollPage;
