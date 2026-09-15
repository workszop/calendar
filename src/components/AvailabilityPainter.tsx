import React, { useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, HelpCircle, Save, Star, X } from 'lucide-react';
import type { Poll, SlotStatus } from '../types';
import { formatTimeSlot } from '../utils/calendar';
import { slotKey } from '../utils/consensus';
import { getBlockStatus, type GridInterval } from '../utils/grid';
import { MAX_EMAIL_LENGTH, MAX_NAME_LENGTH } from '../utils/limits';
import { SLOT_STATUS_LABEL } from '../utils/slotStyles';
import { getStoredUser, setStoredUser } from '../utils/storage';
import { usePollGrid } from '../hooks/usePollGrid';
import { useGridStroke } from '../hooks/useGridStroke';
import { ActionDock } from './ActionDock';
import { SlotTable } from './SlotTable';
import { TimeZoneNote } from './TimeZoneNote';
import './calendar-workspace.css';

/**
 * Why a save failed, so the painter can offer the right next step. The message
 * comes from the server when it gave one.
 * - forbidden: this browser may not edit the stored response (403)
 * - participant-gone: the stored response was removed meanwhile (404)
 * - closed: voting is closed because a time was locked (409)
 * - rate-limited: too many requests (429)
 * - other: any other refusal the server explained (4xx)
 */
export type SaveFailureKind = 'forbidden' | 'participant-gone' | 'closed' | 'rate-limited' | 'other';

export class SaveAvailabilityError extends Error {
  readonly kind: SaveFailureKind;
  constructor(kind: SaveFailureKind, message: string) {
    super(message);
    this.name = 'SaveAvailabilityError';
    this.kind = kind;
  }
}

interface AvailabilityPainterProps {
  poll: Poll;
  /** Display-only interval; answers remain stored at the poll's atomic interval. */
  gridInterval?: GridInterval;
  /**
   * Saves the answer. `participantId` is set when updating this device's own
   * response; `options.asNew` asks to drop that stored response first. `email`
   * is undefined when the field was empty all along, and "" when the user
   * emptied a remembered email, so the stored one is cleared. Rejects with a
   * SaveAvailabilityError when the failure needs a specific next step.
   */
  onSaveAvailability: (
    name: string,
    email: string | undefined,
    availability: Record<string, SlotStatus>,
    participantId?: string,
    options?: { asNew?: boolean }
  ) => Promise<void>;
  onCancel?: () => void;
  /** This device's own saved response, if it has one. Answers load from it, never from a typed name. */
  ownParticipantId?: string;
}

// ─── Constants ───

interface BrushDef {
  status: SlotStatus;
  id: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const BRUSHES: BrushDef[] = [
  { status: 'available', id: 'brush-available', label: 'Available', Icon: Check },
  { status: 'preferred', id: 'brush-preferred', label: 'Preferred', Icon: Star },
  { status: 'if_needed', id: 'brush-if-needed', label: 'If needed', Icon: HelpCircle },
  { status: 'unavailable', id: 'brush-unavailable', label: 'Busy', Icon: X },
];

const SAVE_ERROR_TIMEOUT_MS = 8000;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

// ─── Painter ───

export const AvailabilityPainter: React.FC<AvailabilityPainterProps> = ({
  poll,
  gridInterval,
  onSaveAvailability,
  onCancel,
  ownParticipantId,
}) => {
  // ─── State ───
  const [userName, setUserName] = useState(() => getStoredUser().name);
  const [userEmail, setUserEmail] = useState(() => getStoredUser().email);
  const [activeBrush, setActiveBrush] = useState<SlotStatus>('available');
  const [availability, setAvailability] = useState<Record<string, SlotStatus>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [nameError, setNameError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Set after a 403 on an update: offers saving the painted grid as a new response.
  const [canSaveAsNew, setCanSaveAsNew] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [bulkToolsOpen, setBulkToolsOpen] = useState(false);
  const [pendingBrushFocus, setPendingBrushFocus] = useState<number | null>(null);

  // ─── Refs ───
  // Which participant's saved answers are currently loaded into the grid.
  const loadedParticipantIdRef = useRef<string | undefined>(undefined);
  // The one pending timer: clearing the save error.
  const saveErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The email this device last remembered or saved. Emptying the field after
  // that sends "" so the stored email is cleared, not kept.
  const knownEmailRef = useRef(getStoredUser().email);
  // Brush buttons, for the roving tabindex.
  const brushRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Validation should return the user to the required identity field even
  // though that field lives inside the fixed action dock.
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const { timeSlots, daySlots, blocks, dateHeadings, isProposed } = usePollGrid(poll, gridInterval);
  const effectiveGridInterval = gridInterval ?? poll.slotInterval;
  const activeBrushDef = BRUSHES.find((brush) => brush.status === activeBrush)!;

  // ─── Prefill from this device's own response ───
  // Loads the answers once per participant, so a later poll update never wipes
  // unsaved painting. Typing someone else's name loads nothing: updating a
  // response needs the edit code only the browser that saved it holds.
  const ownParticipant = ownParticipantId
    ? poll.participants.find((participant) => participant.id === ownParticipantId)
    : undefined;

  useEffect(() => {
    if (!ownParticipant || loadedParticipantIdRef.current === ownParticipant.id) return;
    loadedParticipantIdRef.current = ownParticipant.id;
    setAvailability(ownParticipant.availability || {});
    setUserName((previous) => previous || ownParticipant.name);
  }, [ownParticipant]);

  // ─── Timer cleanup ───
  useEffect(
    () => () => {
      if (saveErrorTimerRef.current) clearTimeout(saveErrorTimerRef.current);
    },
    []
  );

  // A nuance brush lives inside a closed disclosure on first render. Defer
  // focus until the disclosure has committed open, otherwise browsers can
  // leave focus on a hidden control or drop it entirely.
  useEffect(() => {
    if (pendingBrushFocus === null) return;
    if (pendingBrushFocus > 0 && !advancedOpen) return;
    const button = brushRefs.current[pendingBrushFocus];
    if (!button) return;
    button.focus();
    setPendingBrushFocus(null);
  }, [advancedOpen, pendingBrushFocus]);

  // ─── Helpers ───
  const markDraftChanged = () => {
    if (!isSaving) setSaveState('idle');
    if (saveError) setSaveError(null);
  };

  const showSaveError = (message: string) => {
    if (saveErrorTimerRef.current) clearTimeout(saveErrorTimerRef.current);
    setSaveError(message);
    setSaveState('error');
    saveErrorTimerRef.current = setTimeout(() => {
      setSaveError(null);
      setSaveState((previous) => (previous === 'error' ? 'idle' : previous));
    }, SAVE_ERROR_TIMEOUT_MS);
  };

  const isBlockFinalized = (key: string) => {
    const block = blocks.get(key);
    const finalized = poll.finalizedSlot;
    if (!block || !finalized || finalized.date !== block.date) return false;
    return block.startTime < finalized.endTime && block.endTime > finalized.startTime;
  };

  const isAtomicSlotFinalized = (key: string) => {
    const separator = key.indexOf('T');
    if (separator < 0) return false;
    const date = key.slice(0, separator);
    const time = key.slice(separator + 1);
    for (const [blockKey, block] of blocks) {
      if (block.date === date && block.slotTimes.includes(time) && isBlockFinalized(blockKey)) return true;
    }
    return false;
  };

  const clearBlock = (key: string) => {
    const block = blocks.get(key);
    if (!block || isBlockFinalized(key)) return;
    markDraftChanged();
    setAvailability((previous) => {
      let changed = false;
      const next = { ...previous };
      block.slotTimes.forEach((time) => {
        const atomicKey = slotKey(block.date, time);
        if (next[atomicKey] !== undefined) {
          delete next[atomicKey];
          changed = true;
        }
      });
      return changed ? next : previous;
    });
  };

  // Answers with every atomic slot under these blocks set to one status.
  const withBlocks = (base: Record<string, SlotStatus>, keys: string[], status: SlotStatus) => {
    const next = { ...base };
    keys.forEach((key) => {
      const block = blocks.get(key);
      if (!block || isBlockFinalized(key)) return;
      block.slotTimes.forEach((time) => {
        next[slotKey(block.date, time)] = status;
      });
    });
    return next;
  };

  const setBlocks = (keys: string[], status: SlotStatus) => {
    markDraftChanged();
    setAvailability((previous) => withBlocks(previous, keys, status));
  };

  const setBlock = (key: string, status: SlotStatus) => setBlocks([key], status);

  // ─── Stroke ───
  // A single click on a cell that already holds the brush clears it; a drag only
  // paints. The brush, that origin state and the answers the rectangle is drawn
  // over are fixed when the stroke begins.
  const strokeBrushRef = useRef<SlotStatus>(activeBrush);
  const strokeOriginHadBrushRef = useRef(false);
  const strokeBaseRef = useRef<Record<string, SlotStatus>>({});

  const stroke = useGridStroke({
    dates: poll.dates,
    times: timeSlots,
    hasCell: (key) => blocks.has(key) && !isBlockFinalized(key),
    disabled: isSaving,
    onBegin: (key) => {
      const block = blocks.get(key);
      if (!block || isBlockFinalized(key)) return;
      markDraftChanged();
      strokeBrushRef.current = activeBrush;
      strokeBaseRef.current = availability;
      strokeOriginHadBrushRef.current = getBlockStatus(availability, block) === activeBrush;
    },
    onPaint: (keys, isOrigin) => {
      if (isOrigin && strokeOriginHadBrushRef.current) return;
      markDraftChanged();
      setAvailability(withBlocks(strokeBaseRef.current, keys, strokeBrushRef.current));
    },
    onEnd: (origin, moved) => {
      if (!moved && strokeOriginHadBrushRef.current) clearBlock(origin);
    },
    // A display interval change replaces the block map mid-stroke: cancel it
    // rather than let the old origin key clear a newly grouped answer.
    resetKey: `${effectiveGridInterval}:${poll.id}`,
  });

  const handleCellKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (isSaving || isBlockFinalized(key)) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const block = blocks.get(key);
    if (!block) return;
    if (getBlockStatus(availability, block) === activeBrush) clearBlock(key);
    else setBlock(key, activeBrush);
  };

  // ─── Brush radiogroup ───
  const handleBrushKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (isSaving) return;
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % BRUSHES.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + BRUSHES.length) % BRUSHES.length;
    else return;
    event.preventDefault();
    setActiveBrush(BRUSHES[next].status);
    markDraftChanged();
    if (next > 0) setAdvancedOpen(true);
    setPendingBrushFocus(next);
  };

  // Fill entire column / day with current brush.
  const handleFillDay = (dateStr: string) => {
    if (isSaving) return;
    markDraftChanged();
    setAvailability((previous) => {
      const next = { ...previous };
      daySlots.get(dateStr)?.forEach((time) => {
        const key = slotKey(dateStr, time);
        if (!isAtomicSlotFinalized(key)) next[key] = activeBrush;
      });
      return next;
    });
  };

  const handleSelectAllAvailable = () => {
    if (isSaving) return;
    markDraftChanged();
    setAvailability((previous) => {
      const next: Record<string, SlotStatus> = {};
      Object.entries(previous).forEach(([key, status]) => {
        if (isAtomicSlotFinalized(key)) next[key] = status;
      });
      poll.dates.forEach((date) => {
        daySlots.get(date)?.forEach((time) => {
          const key = slotKey(date, time);
          if (!isAtomicSlotFinalized(key)) next[key] = 'available';
        });
      });
      return next;
    });
  };

  const handleClearAll = () => {
    if (isSaving) return;
    markDraftChanged();
    setAvailability((previous) => {
      if (!poll.finalizedSlot) return {};
      const next: Record<string, SlotStatus> = {};
      Object.entries(previous).forEach(([key, status]) => {
        if (isAtomicSlotFinalized(key)) next[key] = status;
      });
      return next;
    });
  };

  const save = async (asNew: boolean) => {
    if (isSaving) return;
    if (saveErrorTimerRef.current) clearTimeout(saveErrorTimerRef.current);
    setSaveError(null);
    setSaveState('idle');
    setCanSaveAsNew(false);
    if (!userName.trim()) {
      setNameError('Enter your name to save your availability.');
      nameInputRef.current?.focus();
      return;
    }
    setNameError(null);
    setIsSaving(true);
    setSaveState('saving');
    const email = userEmail.trim();
    // An empty field clears the remembered email too.
    setStoredUser({ name: userName.trim(), email });
    const emailToSend = email || knownEmailRef.current ? email : undefined;

    try {
      if (asNew) {
        await onSaveAvailability(userName.trim(), emailToSend, availability, undefined, { asNew: true });
        loadedParticipantIdRef.current = undefined;
      } else {
        await onSaveAvailability(userName.trim(), emailToSend, availability, ownParticipant?.id);
      }
      knownEmailRef.current = email;
      setSaveState('saved');
    } catch (error) {
      console.error(error);
      const kind = error instanceof SaveAvailabilityError ? error.kind : undefined;
      if (kind === 'participant-gone' || (error instanceof Error && /participant not found/i.test(error.message))) {
        // The response we were updating was removed meanwhile. The app forgets its
        // stored id, so the next save adds a new response.
        loadedParticipantIdRef.current = undefined;
        showSaveError('Your earlier response was removed. Save again to add it as new.');
      } else if (error instanceof SaveAvailabilityError) {
        // The server said why (edit refused, voting closed, rate limit...). After
        // a refused edit the grid stays painted and can be saved as a new response.
        if (kind === 'forbidden') setCanSaveAsNew(true);
        showSaveError(error.message);
      } else {
        showSaveError('Could not save your availability. Please try again.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault();
    void save(false);
  };

  const renderBrush = ({ status, id, label, Icon }: BrushDef, index: number) => {
    const isActive = activeBrush === status;
    return (
      <button
        key={status}
        ref={(element) => {
          brushRefs.current[index] = element;
        }}
        type="button"
        id={id}
        role="radio"
        aria-checked={isActive}
        tabIndex={isActive ? 0 : -1}
        disabled={isSaving}
        onClick={() => {
          setActiveBrush(status);
          markDraftChanged();
        }}
        onKeyDown={(event) => handleBrushKeyDown(event, index)}
        className={`d-answer-brush ${status === 'available' ? 'd-answer-brush--available' : ''}`}
      >
        <Icon className="d-calendar-cell-icon" aria-hidden="true" />
        {label}
      </button>
    );
  };

  const renderDayHeader = (dateStr: string) => {
    const heading = dateHeadings.get(dateStr);
    return (
      <button
        type="button"
        disabled={isSaving}
        onClick={() => handleFillDay(dateStr)}
        aria-label={`Answer all of ${heading?.weekday} ${heading?.dayMonth} with ${activeBrushDef.label}`}
        className="d-answer-day-fill"
      >
        <span className="d-answer-day-weekday">{heading?.weekday}</span>
        <span className="d-answer-day-date">{heading?.dayMonth}</span>
        <span className="d-answer-day-action">Fill day</span>
      </button>
    );
  };

  const renderSlotCell = (dateStr: string, timeStr: string) => {
    const key = slotKey(dateStr, timeStr);
    const block = blocks.get(key);
    if (!block) return null;
    const status = getBlockStatus(availability, block);
    const isFinalized = isBlockFinalized(key);
    const heading = dateHeadings.get(dateStr);
    const answer = SLOT_STATUS_LABEL[status];
    const displayRange = `${formatTimeSlot(block.startTime)} – ${formatTimeSlot(block.endTime)}`;
    const cellLabel = `${heading?.weekday} ${heading?.dayMonth} ${displayRange}: ${
      isFinalized ? 'Confirmed' : answer
    }`;
    const styleClass =
      status === 'preferred'
        ? 'd-calendar-cell--preferred'
        : status === 'available'
          ? 'd-calendar-cell--available'
          : status === 'if_needed'
            ? 'd-calendar-cell--if-needed'
            : status === 'unavailable'
              ? 'd-calendar-cell--unavailable'
              : status === 'mixed'
                ? 'd-calendar-cell--mixed'
                : 'd-calendar-cell--unanswered';

    return (
      <button
        type="button"
        id={`paint-slot-${key}`}
        data-slot-key={key}
        data-status={status}
        data-covered-slots={block.slotTimes.join(',')}
        data-finalized={isFinalized ? 'true' : 'false'}
        disabled={isSaving || isFinalized}
        // A cell consumes a touch gesture for painting, as in DayTimesEditor; the
        // Time column and the page around the grid still scroll.
        style={{ touchAction: 'none' }}
        aria-label={cellLabel}
        title={cellLabel}
        aria-pressed={status !== 'none'}
        {...stroke.cellProps(key)}
        onKeyDown={(event) => handleCellKeyDown(event, key)}
        className={`d-calendar-cell ${styleClass} ${isFinalized ? 'd-answer-slot--locked' : ''}`}
      >
        {isFinalized && <span className="d-calendar-cell-label">Confirmed</span>}
        {!isFinalized && status === 'preferred' && (
          <span className="d-calendar-cell-label">
            <Star className="d-calendar-cell-icon" fill="currentColor" aria-hidden="true" />
            Yes
          </span>
        )}
        {!isFinalized && status === 'available' && (
          <span className="d-calendar-cell-label">
            <Check className="d-calendar-cell-icon" aria-hidden="true" />
            Yes
          </span>
        )}
        {!isFinalized && status === 'if_needed' && <span className="d-calendar-cell-label">Maybe</span>}
        {!isFinalized && status === 'unavailable' && (
          <span className="d-calendar-cell-label">
            <X className="d-calendar-cell-icon" aria-hidden="true" />
            Busy
          </span>
        )}
        {!isFinalized && status === 'mixed' && <span className="d-calendar-cell-label">Mixed</span>}
        {!isFinalized && status === 'none' && <span className="d-calendar-cell-label">Proposed</span>}
      </button>
    );
  };

  const saveStatus =
    saveState === 'saving'
      ? 'Saving your answer...'
      : saveState === 'saved'
        ? 'Saved. You can update your answer any time.'
        : saveState === 'error'
          ? saveError || 'Could not save your answer.'
          : 'Your answer is kept here until you save.';

  return (
    <div
      className="d-answer-workspace"
      aria-busy={isSaving}
      data-answer-state={saveState}
    >
      <section
        className="d-answer-grid"
        data-answer-grid
        data-poll-timezone={poll.timezone}
        data-visual-group="answer-calendar"
        aria-labelledby="answer-grid-title"
      >
        <header className="d-answer-grid-heading">
          <div>
            <p className="d-calendar-kicker">Your availability</p>
            <h3 id="answer-grid-title">
              <CalendarDays
                className="d-calendar-panel-icon"
                data-visual-icon="calendar"
                aria-hidden="true"
              />
              <span>When can you make it?</span>
            </h3>
          </div>
          <p className="d-answer-grid-note">
            Select the times that work. Each cell follows the organizer's proposal.
          </p>
        </header>
        <TimeZoneNote timeZone={poll.timezone} dates={poll.dates} />

        <div className="d-calendar-table-wrap" aria-busy={isSaving} data-answer-table>
          <SlotTable
            dates={poll.dates}
            timeSlots={timeSlots}
            isProposed={isProposed}
            dateHeadings={dateHeadings}
            renderHeader={renderDayHeader}
            renderCell={renderSlotCell}
            cellHeightClass="d-calendar-cell-placeholder"
            tableProps={{ ...stroke.tableProps, 'aria-label': 'Your availability grid' }}
          />
        </div>

        <div className="d-answer-controls" data-visual-group="answer-tools">
          <div className="d-answer-selection-row">
            <span className="d-answer-selection-count" data-selection-count={Object.keys(availability).length}>
              {Object.keys(availability).length} answered blocks · {activeBrushDef.label} selected
            </span>
            <button
              type="button"
              id="clear-selection-btn"
              disabled={isSaving}
              onClick={handleClearAll}
              className="d-answer-clear-button"
            >
              Clear selection
            </button>
          </div>

          <div className="d-answer-brush-row" role="radiogroup" aria-labelledby="brush-group-label">
            <span id="brush-group-label" className="d-calendar-label">
              Answer with
            </span>
            {renderBrush(BRUSHES[0], 0)}
          </div>

          <details
            className="d-answer-disclosure"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary>More answer options</summary>
            <div className="d-answer-disclosure-content" role="radiogroup" aria-labelledby="brush-group-label">
              <div className="d-answer-brush-row">{BRUSHES.slice(1).map((brush, index) => renderBrush(brush, index + 1))}</div>
              <p className="d-answer-disclosure-note">
                Click a cell to apply the chosen answer. Click it again to clear it.
              </p>
            </div>
          </details>

          <details
            className="d-answer-disclosure"
            open={bulkToolsOpen}
            onToggle={(event) => setBulkToolsOpen(event.currentTarget.open)}
          >
            <summary>Quick fill tools</summary>
            <div className="d-answer-disclosure-content d-answer-brush-row">
              <button
                type="button"
                id="fill-all-available-btn"
                disabled={isSaving}
                onClick={handleSelectAllAvailable}
                className="d-answer-clear-button"
              >
                Select All
              </button>
              <button
                type="button"
                id="clear-all-btn"
                disabled={isSaving}
                onClick={handleClearAll}
                className="d-answer-clear-button"
              >
                Clear All
              </button>
            </div>
          </details>
        </div>
      </section>

      <form
        onSubmit={handleSave}
        className="d-answer-form"
        data-answer-footer
        data-visual-group="answer-save"
        data-save-state={saveState}
      >
        <div className="d-answer-email-flow">
          <div className="d-answer-field">
            <label htmlFor="user-email-input">Your Email (Optional)</label>
            <input
              id="user-email-input"
              type="email"
              disabled={isSaving}
              value={userEmail}
              onChange={(event) => {
                setUserEmail(event.target.value);
                markDraftChanged();
              }}
              placeholder="For calendar invite notifications"
              maxLength={MAX_EMAIL_LENGTH}
            />
          </div>
        </div>

        <ActionDock label="Availability actions" className="d-answer-dock">
          <div className="d-answer-dock-content">
            <div className="d-answer-dock-row">
              <div className="d-answer-field d-answer-name-field">
                <label htmlFor="user-name-input">
                  Your Name <span>(required)</span>
                </label>
                <input
                  ref={nameInputRef}
                  id="user-name-input"
                  type="text"
                  aria-required="true"
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? 'user-name-error' : undefined}
                  value={userName}
                  disabled={isSaving}
                  onChange={(event) => {
                    setUserName(event.target.value);
                    markDraftChanged();
                    if (nameError) setNameError(null);
                  }}
                  placeholder="e.g. Alex Rivera"
                  maxLength={MAX_NAME_LENGTH}
                />
                {nameError && (
                  <p id="user-name-error" role="alert" className="d-answer-name-error">
                    {nameError}
                  </p>
                )}
              </div>

              <div className="d-answer-save-actions">
                {onCancel && (
                  <button
                    type="button"
                    id="cancel-painter-btn"
                    onClick={onCancel}
                    disabled={isSaving}
                    className="d-answer-secondary-action"
                  >
                    Cancel
                  </button>
                )}
                <button type="submit" id="save-availability-btn" disabled={isSaving} className="d-answer-save-action">
                  {isSaving ? (
                    'Saving...'
                  ) : (
                    <>
                      <Save className="d-calendar-cell-icon" aria-hidden="true" />
                      Save My Availability
                    </>
                  )}
                </button>
              </div>
            </div>
            <div
              role={saveState === 'error' ? 'alert' : 'status'}
              className="d-answer-save-status"
              data-save-status
              aria-live="polite"
            >
              {saveStatus}
            </div>
            {canSaveAsNew && (
              <button
                type="button"
                id="save-as-new-response-btn"
                data-save-as-new
                disabled={isSaving}
                onClick={() => void save(true)}
                className="d-answer-secondary-action"
              >
                Save as a new response
              </button>
            )}
          </div>
        </ActionDock>
      </form>
    </div>
  );
};
