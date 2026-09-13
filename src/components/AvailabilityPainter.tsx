import React, { useState, useEffect, useRef } from 'react';
import { Star, Check, HelpCircle, X, Save } from 'lucide-react';
import type { Poll, SlotStatus } from '../types';
import { formatTimeSlot } from '../utils/calendar';
import { slotKey } from '../utils/consensus';
import { getBlockStatus, type GridInterval } from '../utils/grid';
import { SLOT_STATUS_CLASS, SLOT_STATUS_LABEL } from '../utils/slotStyles';
import { getStoredUser, setStoredUser } from '../utils/storage';
import { usePollGrid } from '../hooks/usePollGrid';
import { SlotTable } from './SlotTable';

interface AvailabilityPainterProps {
  poll: Poll;
  /** Display-only interval; answers remain stored at the poll's atomic interval. */
  gridInterval?: GridInterval;
  onSaveAvailability: (
    name: string,
    email: string,
    availability: Record<string, SlotStatus>,
    participantId?: string
  ) => Promise<void>;
  onCancel?: () => void;
}

// ─── Constants ───

interface BrushDef {
  status: SlotStatus;
  id: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  activeClass: string;
  inactiveClass: string;
}

const INACTIVE_BRUSH_CLASS = 'bg-stone-50 border-stone-200 text-stone-700 hover:bg-stone-100';

const BRUSHES: BrushDef[] = [
  {
    status: 'available',
    id: 'brush-available',
    label: 'Available',
    Icon: Check,
    activeClass: 'bg-emerald-700 border-emerald-800 text-white',
    inactiveClass: INACTIVE_BRUSH_CLASS,
  },
  {
    status: 'preferred',
    id: 'brush-preferred',
    label: 'Preferred',
    Icon: Star,
    activeClass: 'bg-amber-400 border-amber-500 text-stone-900',
    inactiveClass: INACTIVE_BRUSH_CLASS,
  },
  {
    status: 'if_needed',
    id: 'brush-if-needed',
    label: 'If needed',
    Icon: HelpCircle,
    activeClass: 'bg-amber-200 border-amber-300 text-stone-900',
    inactiveClass: INACTIVE_BRUSH_CLASS,
  },
  {
    status: 'unavailable',
    id: 'brush-unavailable',
    label: 'Busy',
    Icon: X,
    activeClass: 'bg-stone-800 border-stone-900 text-white',
    inactiveClass: 'bg-stone-100 border-stone-200 text-stone-600 hover:bg-stone-200',
  },
];

const SAVE_ERROR_TIMEOUT_MS = 8000;

export const AvailabilityPainter: React.FC<AvailabilityPainterProps> = ({
  poll,
  gridInterval,
  onSaveAvailability,
  onCancel,
}) => {
  // ─── State ───
  const [userName, setUserName] = useState(() => getStoredUser().name);
  const [userEmail, setUserEmail] = useState(() => getStoredUser().email);
  const [activeBrush, setActiveBrush] = useState<SlotStatus>('available');
  const [availability, setAvailability] = useState<Record<string, SlotStatus>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [matchedParticipantId, setMatchedParticipantId] = useState<string | undefined>(undefined);
  const [isPainting, setIsPainting] = useState(false);

  // ─── Refs ───
  // The value one drag stroke writes; null when no stroke is in progress.
  const strokeRef = useRef<SlotStatus | null>(null);
  // Where the stroke started, whether that cell already held the brush, and
  // whether the stroke ever reached a different cell. Together these turn a
  // single click on an already-brushed cell into "clear", while a drag only paints.
  const strokeOriginRef = useRef<string | null>(null);
  const strokeOriginHadBrushRef = useRef(false);
  const strokeMovedRef = useRef(false);
  // Last cell the stroke painted. Pointer events are not fired for every cell a
  // fast pointer crosses, so each step fills the range from here to the new cell.
  const strokeLastRef = useRef<string | null>(null);
  // Which participant's saved answers are currently loaded into the grid.
  const loadedParticipantIdRef = useRef<string | undefined>(undefined);
  // The one pending timer: clearing the save error.
  const saveErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Brush buttons, for the roving tabindex.
  const brushRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const { timeSlots, daySlots, blocks, dateHeadings, isProposed } = usePollGrid(poll, gridInterval);
  const effectiveGridInterval = gridInterval ?? poll.slotInterval;

  const activeBrushDef = BRUSHES.find((b) => b.status === activeBrush)!;

  // ─── Prefill from a matching participant ───
  // Loads their answers only when the matched participant actually changes, so an
  // unrelated update to poll.participants - or the same name re-matching the same
  // person - never wipes unsaved painting. A name that matches nobody drops the id,
  // so saving creates a new participant instead of renaming someone else.
  useEffect(() => {
    const typed = userName.trim().toLowerCase();
    const match = typed
      ? poll.participants.find((p) => p.name.toLowerCase() === typed)
      : undefined;

    if (!match) {
      setMatchedParticipantId(undefined);
      loadedParticipantIdRef.current = undefined;
      return;
    }

    setMatchedParticipantId(match.id);
    if (loadedParticipantIdRef.current !== match.id) {
      loadedParticipantIdRef.current = match.id;
      setAvailability(match.availability || {});
      if (match.email) setUserEmail((prev) => prev || match.email || '');
    }
  }, [userName, poll.participants]);

  // ─── Timer cleanup ───
  useEffect(
    () => () => {
      if (saveErrorTimerRef.current) clearTimeout(saveErrorTimerRef.current);
    },
    []
  );

  // ─── Helpers ───
  const showSaveError = (message: string) => {
    if (saveErrorTimerRef.current) clearTimeout(saveErrorTimerRef.current);
    setSaveError(message);
    saveErrorTimerRef.current = setTimeout(() => setSaveError(null), SAVE_ERROR_TIMEOUT_MS);
  };

  const clearBlock = (key: string) => {
    const block = blocks.get(key);
    if (!block) return;
    setAvailability((prev) => {
      let changed = false;
      const next = { ...prev };
      block.slotTimes.forEach((time) => {
        const atomicKey = slotKey(block.date, time);
        if (next[atomicKey] !== undefined) {
          delete next[atomicKey];
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  };

  // Every block key in the rectangle spanned by two cells (dates x rows).
  const blockKeysBetween = (fromKey: string, toKey: string): string[] => {
    const from = blocks.get(fromKey);
    const to = blocks.get(toKey);
    if (!from || !to) return to ? [toKey] : [];
    const dateA = poll.dates.indexOf(from.date);
    const dateB = poll.dates.indexOf(to.date);
    const timeA = timeSlots.indexOf(from.startTime);
    const timeB = timeSlots.indexOf(to.startTime);
    if (dateA < 0 || dateB < 0 || timeA < 0 || timeB < 0) return [toKey];
    const keys: string[] = [];
    for (let d = Math.min(dateA, dateB); d <= Math.max(dateA, dateB); d++) {
      for (let t = Math.min(timeA, timeB); t <= Math.max(timeA, timeB); t++) {
        const key = slotKey(poll.dates[d], timeSlots[t]);
        if (blocks.has(key)) keys.push(key);
      }
    }
    return keys;
  };

  const setBlocks = (keys: string[], status: SlotStatus) => {
    setAvailability((prev) => {
      let changed = false;
      const next = { ...prev };
      keys.forEach((key) => {
        const block = blocks.get(key);
        block?.slotTimes.forEach((time) => {
          const atomicKey = slotKey(block.date, time);
          if (next[atomicKey] !== status) {
            next[atomicKey] = status;
            changed = true;
          }
        });
      });
      return changed ? next : prev;
    });
  };

  const setBlock = (key: string, status: SlotStatus) => setBlocks([key], status);

  const applyStroke = (key: string) => {
    const value = strokeRef.current;
    if (!value) return;
    if (key === strokeLastRef.current) return;
    if (key !== strokeOriginRef.current) strokeMovedRef.current = true;
    const from = strokeLastRef.current ?? key;
    strokeLastRef.current = key;
    setBlocks(blockKeysBetween(from, key), value);
  };

  // ─── Stroke lifecycle ───
  // Ending on window means releasing outside the grid, opening a context menu or
  // losing the window never leaves a stroke stuck.
  useEffect(() => {
    if (!isPainting) return;
    const endStroke = () => {
      const origin = strokeOriginRef.current;
      // A click that never left its cell, on a cell that already held the brush,
      // clears the answer instead of repainting it.
      if (origin && !strokeMovedRef.current && strokeOriginHadBrushRef.current) {
        clearBlock(origin);
      }
      strokeRef.current = null;
      strokeOriginRef.current = null;
      strokeOriginHadBrushRef.current = false;
      strokeMovedRef.current = false;
      strokeLastRef.current = null;
      setIsPainting(false);
    };
    window.addEventListener('pointerup', endStroke);
    window.addEventListener('pointercancel', endStroke);
    window.addEventListener('contextmenu', endStroke);
    window.addEventListener('blur', endStroke);
    return () => {
      window.removeEventListener('pointerup', endStroke);
      window.removeEventListener('pointercancel', endStroke);
      window.removeEventListener('contextmenu', endStroke);
      window.removeEventListener('blur', endStroke);
    };
  }, [isPainting]);

  // A display interval change replaces the block map while a pointer stroke may
  // still be held. Cancel the stroke without applying its click-to-clear action;
  // otherwise the old block key could clear the newly grouped answer on pointerup.
  useEffect(() => {
    strokeRef.current = null;
    strokeOriginRef.current = null;
    strokeOriginHadBrushRef.current = false;
    strokeMovedRef.current = false;
    strokeLastRef.current = null;
    setIsPainting(false);
  }, [effectiveGridInterval, poll.id]);

  const handleCellPointerDown = (e: React.PointerEvent<HTMLButtonElement>, key: string) => {
    if (isSaving) return;
    // Left button only; a right-click or middle-click must not start painting.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType !== 'mouse' && e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    // Touch pointers are implicitly captured by the origin element; release so the
    // grid-level pointermove hit-testing can paint across neighbouring cells.
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const block = blocks.get(key);
    const hadBrush = block ? getBlockStatus(availability, block) === activeBrush : false;
    strokeRef.current = activeBrush;
    strokeOriginRef.current = key;
    strokeOriginHadBrushRef.current = hadBrush;
    strokeMovedRef.current = false;
    strokeLastRef.current = key;
    setIsPainting(true);
    if (!hadBrush) setBlock(key, activeBrush);
  };

  const handleCellPointerEnter = (e: React.PointerEvent<HTMLButtonElement>, key: string) => {
    if (isSaving) return;
    if (e.pointerType === 'mouse' && strokeRef.current) applyStroke(key);
  };

  // Touch and pen do not fire pointerenter on the elements they pass over, so the
  // grid hit-tests the pointer position itself.
  const handleGridPointerMove = (e: React.PointerEvent<HTMLTableElement>) => {
    if (isSaving) return;
    if (!strokeRef.current || e.pointerType === 'mouse') return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const cell = target?.closest('[data-slot-key]');
    const key = cell?.getAttribute('data-slot-key');
    if (key) applyStroke(key);
  };

  const handleCellKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (isSaving) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const block = blocks.get(key);
    if (!block) return;
    if (getBlockStatus(availability, block) === activeBrush) clearBlock(key);
    else setBlock(key, activeBrush);
  };

  // ─── Brush radiogroup ───
  const handleBrushKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (isSaving) return;
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % BRUSHES.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (index - 1 + BRUSHES.length) % BRUSHES.length;
    else return;
    e.preventDefault();
    setActiveBrush(BRUSHES[next].status);
    brushRefs.current[next]?.focus();
  };

  // Fill entire column / day with current brush
  const handleFillDay = (dateStr: string) => {
    if (isSaving) return;
    setAvailability((prev) => {
      const next = { ...prev };
      daySlots.get(dateStr)?.forEach((time) => {
        next[slotKey(dateStr, time)] = activeBrush;
      });
      return next;
    });
  };

  const handleSelectAllAvailable = () => {
    if (isSaving) return;
    const next: Record<string, SlotStatus> = {};
    poll.dates.forEach((date) => {
      daySlots.get(date)?.forEach((time) => {
        next[slotKey(date, time)] = 'available';
      });
    });
    setAvailability(next);
  };

  const handleClearAll = () => {
    if (isSaving) return;
    setAvailability({});
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    if (saveErrorTimerRef.current) clearTimeout(saveErrorTimerRef.current);
    setSaveError(null);
    if (!userName.trim()) {
      setNameError('Enter your name to save your availability.');
      return;
    }
    setNameError(null);
    setIsSaving(true);
    setStoredUser({ name: userName.trim(), email: userEmail.trim() || undefined });

    try {
      await onSaveAvailability(userName.trim(), userEmail.trim(), availability, matchedParticipantId);
    } catch (err) {
      console.error(err);
      if (err instanceof Error && /participant not found/i.test(err.message)) {
        // The response we were updating was removed meanwhile: save as a new one next time.
        setMatchedParticipantId(undefined);
        loadedParticipantIdRef.current = undefined;
        showSaveError('Your earlier response was removed. Save again to add it as new.');
      } else {
        showSaveError('Could not save your availability. Please try again.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  // ─── Render ───
  const renderDayHeader = (dateStr: string) => {
    const heading = dateHeadings.get(dateStr);
    return (
      <button
        type="button"
        disabled={isSaving}
        onClick={() => handleFillDay(dateStr)}
        aria-label={`Answer all of ${heading?.weekday} ${heading?.dayMonth} with ${activeBrushDef.label}`}
        className="w-full py-3 px-3 hover:bg-stone-100 transition-colors"
      >
        <div className="text-xs font-semibold uppercase tracking-wider font-mono text-stone-500">
          {heading?.weekday}
        </div>
        <div className="text-sm font-bold text-stone-900 mt-0.5">{heading?.dayMonth}</div>
        <span className="block text-[10px] font-mono uppercase tracking-wider text-stone-500 mt-0.5">
          Fill day
        </span>
      </button>
    );
  };

  const renderSlotCell = (dateStr: string, timeStr: string) => {
    const key = slotKey(dateStr, timeStr);
    const block = blocks.get(key);
    if (!block) return null;
    const status = getBlockStatus(availability, block);
    const styleClass = SLOT_STATUS_CLASS[status];
    const heading = dateHeadings.get(dateStr);
    const answer = SLOT_STATUS_LABEL[status];
    const displayRange = `${formatTimeSlot(block.startTime)} – ${formatTimeSlot(block.endTime)}`;
    const cellLabel = `${heading?.weekday} ${heading?.dayMonth} ${displayRange}: ${answer}`;

    return (
      <button
        type="button"
        id={`paint-slot-${key}`}
        data-slot-key={key}
        data-status={status}
        data-covered-slots={block.slotTimes.join(',')}
        disabled={isSaving}
        style={{ touchAction: 'pan-y' }}
        aria-label={cellLabel}
        title={cellLabel}
        aria-pressed={status !== 'none'}
        onPointerDown={(e) => handleCellPointerDown(e, key)}
        onPointerEnter={(e) => handleCellPointerEnter(e, key)}
        onKeyDown={(e) => handleCellKeyDown(e, key)}
        className={`w-full h-10 rounded-lg border flex items-center justify-center transition-colors cursor-pointer ${styleClass}`}
      >
        {status === 'preferred' && (
          <span className="inline-flex items-center gap-0.5 text-xs">
            <Star className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
            Yes
          </span>
        )}
        {status === 'available' && (
          <span className="inline-flex items-center gap-0.5 text-xs">
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
            Yes
          </span>
        )}
        {status === 'if_needed' && <span className="text-xs">Maybe</span>}
        {status === 'unavailable' && (
          <span className="inline-flex items-center gap-0.5 text-xs">
            <X className="w-3.5 h-3.5" aria-hidden="true" />
            Busy
          </span>
        )}
        {status === 'mixed' && <span className="text-xs">Mixed</span>}
        {status === 'none' && <span className="text-[11px]">Proposed</span>}
      </button>
    );
  };

  return (
    <div className="space-y-4 select-none" aria-busy={isSaving}>
      {/* User Information & Paint Brush Toolbar */}
      <form onSubmit={handleSave} className="bg-white border border-stone-200 rounded-2xl p-5 shadow-xs space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="user-name-input" className="edu-label">
                Your Name <span className="text-stone-500 normal-case">(required)</span>
              </label>
              <input
                id="user-name-input"
                type="text"
                aria-required="true"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? 'user-name-error' : undefined}
                value={userName}
                disabled={isSaving}
                onChange={(e) => {
                  setUserName(e.target.value);
                  if (nameError) setNameError(null);
                }}
                placeholder="e.g. Alex Rivera"
                className="edu-input"
              />
              {nameError && (
                <p id="user-name-error" role="alert" className="mt-1 text-xs font-medium text-red-700">
                  {nameError}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="user-email-input" className="edu-label">
                Your Email (Optional)
              </label>
              <input
                id="user-email-input"
                type="email"
                disabled={isSaving}
                value={userEmail}
                onChange={(e) => setUserEmail(e.target.value)}
                placeholder="For calendar invite notifications"
                className="edu-input"
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col items-end gap-1 self-end md:self-center">
            <div className="flex items-center gap-2">
              {onCancel && (
                <button type="button" id="cancel-painter-btn" onClick={onCancel} disabled={isSaving} className="edu-btn-secondary">
                  Cancel
                </button>
              )}

              <button type="submit" id="save-availability-btn" disabled={isSaving} className="edu-btn-primary px-5 py-2.5">
                {isSaving ? (
                  'Saving...'
                ) : (
                  <>
                    <Save className="w-4 h-4" aria-hidden="true" />
                    Save My Availability
                  </>
                )}
              </button>
            </div>
            {saveError && (
              <p role="alert" className="text-xs font-medium text-red-700">
                {saveError}
              </p>
            )}
          </div>
        </div>

        {/* Brush Selection & Quick Fill Tools */}
        <div className="pt-2 border-t border-stone-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div
            role="radiogroup"
            aria-labelledby="brush-group-label"
            className="flex flex-wrap items-center gap-2"
          >
            <span
              id="brush-group-label"
              className="text-xs font-semibold text-stone-500 uppercase tracking-wider font-mono mr-1"
            >
              Your answer:
            </span>

            {BRUSHES.map(({ status, id, label, Icon, activeClass, inactiveClass }, index) => {
              const isActive = activeBrush === status;
              return (
                <button
                  key={status}
                  ref={(el) => {
                    brushRefs.current[index] = el;
                  }}
                  type="button"
                  id={id}
                  role="radio"
                  aria-checked={isActive}
                  tabIndex={isActive ? 0 : -1}
                  disabled={isSaving}
                  onClick={() => setActiveBrush(status)}
                  onKeyDown={(e) => handleBrushKeyDown(e, index)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors border ${
                    isActive ? activeClass : inactiveClass
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              id="fill-all-available-btn"
              disabled={isSaving}
              onClick={handleSelectAllAvailable}
              className="text-stone-600 hover:text-stone-900 font-medium underline underline-offset-2"
            >
              Select All
            </button>
            <span className="text-stone-300">•</span>
            <button
              type="button"
              id="clear-all-btn"
              disabled={isSaving}
              onClick={handleClearAll}
              className="text-stone-600 hover:text-stone-900 font-medium underline underline-offset-2"
            >
              Clear All
            </button>
          </div>
        </div>
      </form>

      {/* Grid Canvas to Drag and Paint */}
      <div className="bg-white border border-stone-200 rounded-2xl shadow-xs overflow-hidden" aria-busy={isSaving}>
        <div className="p-3 bg-stone-50 border-b border-stone-200 text-xs text-stone-600 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <span>
            <strong className="text-stone-900">Tip:</strong> These days and hours are the organizer's proposals. Click or drag across slots to answer; click an answered slot again to clear it, or use a day header to answer the whole day.
          </span>
          <span className="text-stone-500">
            Answering with:{' '}
            <strong className="text-stone-900">{activeBrushDef.label}</strong>
          </span>
        </div>

        <SlotTable
          poll={poll}
          timeSlots={timeSlots}
          isProposed={isProposed}
          dateHeadings={dateHeadings}
          renderHeader={renderDayHeader}
          renderCell={renderSlotCell}
          cellHeightClass="h-10"
          tableProps={{ onPointerMove: handleGridPointerMove }}
        />
      </div>
    </div>
  );
};
