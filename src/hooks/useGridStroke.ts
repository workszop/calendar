import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { slotKey } from '../utils/consensus';

// ─── Drag-to-paint over a date x time grid ───
// Shared by the availability painter and the organizer's proposal grid. It owns
// the pointer plumbing only: what a stroke writes is decided by the callbacks.

export interface GridStrokeOptions {
  /** Grid columns, in display order. */
  dates: string[];
  /** Grid rows ("HH:mm" cell starts), in display order. */
  times: string[];
  /** Whether a cell exists at this key (blank spacer cells do not). */
  hasCell: (key: string) => boolean;
  /** Blocks every interaction, e.g. while saving. */
  disabled?: boolean;
  /** A stroke starts on this cell. */
  onBegin: (key: string) => void;
  /**
   * Paint these cells. Called with the origin on pointerdown, then with the whole
   * rectangle from the origin to the current cell. Each call replaces the last,
   * so consumers apply it to a snapshot taken in onBegin: shrinking the
   * rectangle restores cells, and cells a fast pointer skipped are still filled.
   */
  onPaint: (keys: string[], isOrigin: boolean) => void;
  /** The stroke ended; `moved` is false for a click that never left its cell. */
  onEnd?: (origin: string, moved: boolean) => void;
  /** Changing this cancels an in-flight stroke without calling onEnd. */
  resetKey?: unknown;
}

export interface GridStroke {
  cellProps: (key: string) => {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
  };
  tableProps: { onPointerMove: (e: React.PointerEvent<HTMLTableElement>) => void };
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf('T');
  return [key.slice(0, index), key.slice(index + 1)];
}

export function useGridStroke(options: GridStrokeOptions): GridStroke {
  // Callbacks and grid shape change every render; the window listeners read
  // the latest through this ref instead of re-subscribing.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [isPainting, setIsPainting] = useState(false);
  const originRef = useRef<string | null>(null);
  // Last cell reached, so repeated events over one cell do not repaint.
  const lastRef = useRef<string | null>(null);
  const movedRef = useRef(false);

  const reset = () => {
    originRef.current = null;
    lastRef.current = null;
    movedRef.current = false;
    setIsPainting(false);
  };

  // Every existing cell in the rectangle spanned by two cells.
  const keysBetween = (fromKey: string, toKey: string): string[] => {
    const { dates, times, hasCell } = optionsRef.current;
    const [fromDate, fromTime] = splitKey(fromKey);
    const [toDate, toTime] = splitKey(toKey);
    const dateA = dates.indexOf(fromDate);
    const dateB = dates.indexOf(toDate);
    const timeA = times.indexOf(fromTime);
    const timeB = times.indexOf(toTime);
    if (dateA < 0 || dateB < 0 || timeA < 0 || timeB < 0) return hasCell(toKey) ? [toKey] : [];
    const keys: string[] = [];
    for (let d = Math.min(dateA, dateB); d <= Math.max(dateA, dateB); d++) {
      for (let t = Math.min(timeA, timeB); t <= Math.max(timeA, timeB); t++) {
        const key = slotKey(dates[d], times[t]);
        if (hasCell(key)) keys.push(key);
      }
    }
    return keys;
  };

  const extendTo = (key: string) => {
    if (!originRef.current || key === lastRef.current) return;
    if (key !== originRef.current) movedRef.current = true;
    lastRef.current = key;
    optionsRef.current.onPaint(keysBetween(originRef.current, key), false);
  };

  // Ending on window means releasing outside the grid, opening a context menu or
  // losing the window never leaves a stroke stuck.
  useEffect(() => {
    if (!isPainting) return;
    const endStroke = () => {
      const origin = originRef.current;
      const moved = movedRef.current;
      reset();
      if (origin) optionsRef.current.onEnd?.(origin, moved);
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

  // A changed grid invalidates the stroke's keys: cancel without onEnd, so a
  // stale origin can never trigger a click action on the new grid.
  useEffect(() => {
    reset();
  }, [options.resetKey]);

  const cellProps = (key: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (optionsRef.current.disabled) return;
      // A locked cell (e.g. a finalized block) can still receive pointer events
      // while its button is disabled; it must not start a stroke.
      if (!optionsRef.current.hasCell(key)) return;
      // Left button only; a right-click or middle-click must not start painting.
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.pointerType !== 'mouse' && e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      // Touch pointers are implicitly captured by the origin element; release so
      // the grid-level pointermove hit-testing can paint across neighbouring cells.
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      originRef.current = key;
      lastRef.current = key;
      movedRef.current = false;
      setIsPainting(true);
      optionsRef.current.onBegin(key);
      optionsRef.current.onPaint([key], true);
    },
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      if (optionsRef.current.disabled) return;
      if (e.pointerType === 'mouse') extendTo(key);
    },
  });

  // Touch and pen do not fire pointerenter on the elements they pass over, so the
  // grid hit-tests the pointer position itself.
  const tableProps = {
    onPointerMove: (e: React.PointerEvent<HTMLTableElement>) => {
      if (optionsRef.current.disabled || e.pointerType === 'mouse' || !originRef.current) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const key = target?.closest('[data-slot-key]')?.getAttribute('data-slot-key');
      if (key) extendTo(key);
    },
  };

  return { cellProps, tableProps };
}
