import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Users, Star, Check, X, HelpCircle, Lock, CalendarCheck } from 'lucide-react';
import type { Poll, SlotAnalysis } from '../types';
import { formatTimeSlot } from '../utils/calendar';
import { getMeetingWindow, slotKey } from '../utils/consensus';
import { analyzeGridBlock, getBlockStatus, type GridInterval } from '../utils/grid';
import { SLOT_STATUS_CLASS, SLOT_STATUS_LABEL } from '../utils/slotStyles';
import { usePollGrid } from '../hooks/usePollGrid';
import { SlotTable } from './SlotTable';

interface HeatmapGridProps {
  poll: Poll;
  gridInterval?: GridInterval;
  /** Only supplied when finalizing is allowed; the agree button hides without it. */
  onFinalizeSlot?: (date: string, startTime: string, endTime: string) => void;
  activeParticipantFilter: string | null;
  onSelectParticipantFilter: (id: string | null) => void;
}

// ─── Cell ───
// Memoized so moving the pointer across the grid re-renders the two cells whose
// state changed, not every cell in the matrix.

interface HeatCellProps {
  analysis: SlotAnalysis;
  className: string;
  label: string;
  isPinned: boolean;
  isInspected: boolean;
  isFinalized: boolean;
  /** The filtered participant's own answer, or null when showing the group heatmap. */
  ownAnswer: string | null;
  totalParticipants: number;
  onHover: (key: string) => void;
  onFocus: (key: string) => void;
  onPin: (key: string) => void;
}

const HeatCell = React.memo<HeatCellProps>(function HeatCell({
  analysis,
  className,
  label,
  isPinned,
  isInspected,
  isFinalized,
  ownAnswer,
  totalParticipants,
  onHover,
  onFocus,
  onPin,
}) {
  const ringClass = isPinned
    ? 'ring-2 ring-stone-900 ring-offset-1 font-bold'
    : isFinalized
      ? 'ring-2 ring-stone-900 ring-offset-1 font-bold'
      : isInspected
        ? 'ring-1 ring-stone-400'
        : '';

  return (
    <button
      id={`slot-${analysis.date}-${analysis.timeStr}`}
      type="button"
      aria-label={label}
      aria-pressed={isPinned}
      onClick={() => onPin(analysis.slotKey)}
      onMouseEnter={() => onHover(analysis.slotKey)}
      onFocus={() => onFocus(analysis.slotKey)}
      className={`w-full h-11 rounded-lg border flex flex-col items-center justify-center transition-colors cursor-pointer relative ${className} ${ringClass}`}
    >
      <div className="flex items-center gap-1 text-xs">
        {isFinalized ? (
          <span className="flex items-center gap-0.5 text-xs">
            <Lock className="w-3 h-3" aria-hidden="true" /> Confirmed
          </span>
        ) : ownAnswer !== null ? (
          <span>{ownAnswer}</span>
        ) : (
          <>
            <span>
              {analysis.availableCount}/{totalParticipants}
            </span>
            {analysis.preferredCount > 0 && (
              <Star className="w-3 h-3 fill-current" aria-hidden="true" />
            )}
          </>
        )}
      </div>

      {/* Percentage sub-indicator - same colour as the count, just smaller */}
      {totalParticipants > 0 && !isFinalized && ownAnswer === null && (
        <span className="text-[10px] font-normal">
          {Math.round(analysis.attendanceRate * 100)}%
        </span>
      )}
    </button>
  );
});

export const HeatmapGrid: React.FC<HeatmapGridProps> = ({
  poll,
  gridInterval,
  onFinalizeSlot,
  activeParticipantFilter,
  onSelectParticipantFilter,
}) => {
  // ─── State ───
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const { timeSlots, blocks, dateHeadings, isProposed } = usePollGrid(poll, gridInterval);
  const totalParticipants = poll.participants.length;

  // A different poll shares none of these keys.
  useEffect(() => {
    setHoveredKey(null);
    setPinnedKey(null);
    setFocusedKey(null);
  }, [poll.id, gridInterval]);

  // ─── Derived data ───
  // Render and inspector share the same full-block attendance analysis.
  const analyses = useMemo(() => {
    const map = new Map<string, SlotAnalysis>();
    blocks.forEach((block, key) => map.set(key, analyzeGridBlock(poll, block)));
    return map;
  }, [poll, blocks]);

  const filteredParticipant = activeParticipantFilter
    ? poll.participants.find((p) => p.id === activeParticipantFilter) ?? null
    : null;

  const getHeatBgColor = (analysis: SlotAnalysis): string => {
    if (totalParticipants === 0) return 'bg-stone-50 border-stone-200 text-stone-400';

    // Filtering by one participant: show their own answer, styled exactly as the painter does
    if (filteredParticipant) {
      return SLOT_STATUS_CLASS[getBlockStatus(filteredParticipant.availability, blocks.get(analysis.slotKey)!)];
    }

    // Group heatmap
    if (analysis.availableCount === 0 && analysis.ifNeededCount === 0) {
      return 'bg-stone-100 border-stone-200 text-stone-500 hover:bg-stone-200';
    }

    const rate = analysis.availableCount / totalParticipants;

    if (rate === 1) {
      return 'bg-emerald-700 border-emerald-800 text-white font-bold hover:bg-emerald-800';
    }
    if (rate >= 0.75) {
      return 'bg-emerald-500 border-emerald-600 text-stone-900 font-semibold hover:bg-emerald-600';
    }
    if (rate >= 0.5) {
      return 'bg-emerald-400 border-emerald-500 text-stone-900 font-medium hover:bg-emerald-500';
    }
    if (rate >= 0.25) {
      return 'bg-emerald-200 border-emerald-300 text-stone-900 hover:bg-emerald-300';
    }
    if (analysis.availableCount > 0) {
      return 'bg-emerald-100 border-emerald-200 text-stone-900 hover:bg-emerald-200';
    }
    // Only if_needed
    return 'bg-amber-100 border-amber-200 text-stone-900 hover:bg-amber-200';
  };

  const isSlotFinalized = (date: string, time: string) => {
    const block = blocks.get(slotKey(date, time));
    if (!poll.finalizedSlot || !block) return false;
    return poll.finalizedSlot.date === date && block.startTime < poll.finalizedSlot.endTime && block.endTime > poll.finalizedSlot.startTime;
  };

  // Hover wins while the pointer is over a cell; the pinned cell is what the panel
  // falls back to, so moving the pointer away restores it.
  const inspectedKey = hoveredKey ?? pinnedKey;
  const inspected = inspectedKey ? analyses.get(inspectedKey) ?? null : null;

  // ─── Callbacks (stable, so HeatCell's memo holds) ───
  const handleHover = useCallback((key: string) => setHoveredKey(key), []);
  const handleFocus = useCallback((key: string) => setFocusedKey(key), []);
  const handlePin = useCallback(
    (key: string) => setPinnedKey((prev) => (prev === key ? null : key)),
    []
  );

  // Escape drops both the pinned and the hovered slot.
  const handleGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    setPinnedKey(null);
    setHoveredKey(null);
    setFocusedKey(null);
  };

  // ─── Inspector content ───
  const buildDetail = (analysis: SlotAnalysis) => {
    const dateHead = dateHeadings.get(analysis.date);
    const preferredSet = new Set(analysis.preferredNames);
    const meetingWindow = getMeetingWindow(poll, analysis.date, analysis.timeStr);
    return {
      analysis,
      dateHead,
      endTime: blocks.get(analysis.slotKey)!.endTime,
      meetingWindow,
      isConfirmed: isSlotFinalized(analysis.date, analysis.timeStr),
      availableOnly: analysis.availableNames.filter((n) => !preferredSet.has(n)),
    };
  };

  const inspectedDetail = inspected ? buildDetail(inspected) : null;

  // Announced only when a cell is pinned or reached by keyboard - mouse hover
  // sweeping the grid would make the live region unbearably chatty.
  const announcedKey = focusedKey ?? pinnedKey;
  const announced = announcedKey ? analyses.get(announcedKey) ?? null : null;
  const announcement = announced
    ? `${dateHeadings.get(announced.date)?.weekday ?? ''} ${
        dateHeadings.get(announced.date)?.dayMonth ?? ''
      }, ${announced.displayTime}: ${announced.availableCount} of ${totalParticipants} available` +
      (announced.preferredCount > 0 ? `, ${announced.preferredCount} preferred` : '')
    : '';

  // Finalizing acts on the pinned cell, never on whatever the pointer happens to
  // be over, and only when the parent allows it at all.
  const pinnedAnalysis = pinnedKey ? analyses.get(pinnedKey) ?? null : null;
  const pinnedDetail = pinnedAnalysis ? buildDetail(pinnedAnalysis) : null;
  const pinnedMeetingWindow = pinnedDetail?.meetingWindow ?? null;

  // ─── Render ───
  const renderCell = (dateStr: string, timeStr: string) => {
    const key = slotKey(dateStr, timeStr);
    const analysis = analyses.get(key);
    if (!analysis) return null;

    const heading = dateHeadings.get(dateStr);
    const displayTime = `${formatTimeSlot(timeStr)} – ${formatTimeSlot(blocks.get(key)!.endTime)}`;
    const ownAnswer = filteredParticipant
      ? SLOT_STATUS_LABEL[getBlockStatus(filteredParticipant.availability, blocks.get(key)!)]
      : null;

    const label = filteredParticipant
      ? `${heading?.weekday} ${heading?.dayMonth} ${displayTime}, ${filteredParticipant.name}: ${ownAnswer}`
      : `${heading?.weekday} ${heading?.dayMonth} ${displayTime}, ${analysis.availableCount} of ${totalParticipants} available` +
        (analysis.preferredCount > 0 ? `, preferred by ${analysis.preferredCount}` : '');

    return (
      <HeatCell
        analysis={analysis}
        className={getHeatBgColor(analysis)}
        label={label}
        isPinned={pinnedKey === key}
        isInspected={inspectedKey === key}
        isFinalized={isSlotFinalized(dateStr, timeStr)}
        ownAnswer={ownAnswer}
        totalParticipants={totalParticipants}
        onHover={handleHover}
        onFocus={handleFocus}
        onPin={handlePin}
      />
    );
  };

  return (
    <div className="space-y-4" data-grid-interval={gridInterval ?? poll.slotInterval}>
      {/* Participants Filter & Overview Bar */}
      <div className="bg-white border border-stone-200 rounded-2xl p-4 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div role="group" aria-labelledby="filter-view-label" className="flex flex-wrap items-center gap-2">
          <span
            id="filter-view-label"
            className="text-xs font-semibold text-stone-500 uppercase tracking-wider font-mono mr-1"
          >
            Filter View:
          </span>
          <button
            id="filter-everyone-btn"
            type="button"
            aria-pressed={activeParticipantFilter === null}
            onClick={() => onSelectParticipantFilter(null)}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
              activeParticipantFilter === null
                ? 'bg-yellow-500 text-yellow-950'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
            }`}
          >
            Everyone ({totalParticipants})
          </button>

          {poll.participants.map((p) => {
            const isSelected = activeParticipantFilter === p.id;
            return (
              <button
                key={p.id}
                id={`filter-participant-${p.id}`}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectParticipantFilter(isSelected ? null : p.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  isSelected
                    ? 'bg-yellow-500 text-yellow-950 font-semibold'
                    : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
                }`}
              >
                {p.name}
              </button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-3 text-xs text-stone-600 font-medium">
          <span className="text-stone-500">Availability:</span>
          <div className="flex items-center gap-1">
            <span className="w-3.5 h-3.5 rounded bg-stone-100 border border-stone-200 inline-block" />
            <span>0</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-3.5 h-3.5 rounded bg-emerald-200 border border-emerald-300 inline-block" />
            <span>Some</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-3.5 h-3.5 rounded bg-emerald-700 border border-emerald-800 inline-block" />
            <span>All ({totalParticipants})</span>
          </div>
          <div className="flex items-center gap-1">
            <Star className="w-3.5 h-3.5 text-stone-900 fill-current inline-block" aria-hidden="true" />
            <span>Preferred</span>
          </div>
        </div>
      </div>

      {/* Main Heatmap Matrix */}
      <div
        onKeyDown={handleGridKeyDown}
        className="bg-white border border-stone-200 rounded-2xl shadow-xs overflow-hidden"
      >
        <div onMouseLeave={() => setHoveredKey(null)}>
          <SlotTable
            poll={poll}
            timeSlots={timeSlots}
            isProposed={isProposed}
            dateHeadings={dateHeadings}
            renderCell={renderCell}
            cellHeightClass="h-11"
            tableProps={{ 'aria-label': 'Group availability grid' }}
          />
        </div>

        {/* Dynamic Detail Inspector / Hover Panel */}
        <div className="border-t border-stone-200 bg-stone-50 p-4 min-h-[76px] flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs">
          <div className="space-y-1">
            <p className="flex flex-wrap items-center gap-2 empty:hidden">
              {inspectedDetail && (
                <>
                  <span className="font-bold text-stone-900 text-sm">
                    {inspectedDetail.dateHead?.weekday}, {inspectedDetail.dateHead?.dayMonth} •{' '}
                    {inspectedDetail.analysis.displayTime} – {formatTimeSlot(inspectedDetail.endTime)}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-green-600 text-white font-semibold text-xs">
                    {inspectedDetail.analysis.availableCount} of {totalParticipants} available (
                    {Math.round(inspectedDetail.analysis.attendanceRate * 100)}%)
                  </span>
                  {inspectedDetail.analysis.preferredCount > 0 && (
                    <span className="text-stone-600">
                      {inspectedDetail.analysis.preferredCount} preferred
                    </span>
                  )}
                </>
              )}
            </p>

            {/* Pinning a cell or reaching one with the keyboard announces it; the
                name lists change with it and are left to the visible panel. */}
            <span aria-live="polite" className="sr-only">
              {announcement}
            </span>

            {inspectedDetail && (
              <div className="flex flex-wrap items-center gap-3 text-stone-600">
                  {inspectedDetail.analysis.preferredNames.length > 0 && (
                    <div className="flex items-center gap-1 text-stone-600">
                      <Star className="w-3 h-3 fill-current text-stone-900" aria-hidden="true" />
                      <span className="font-medium text-stone-900">Preferred:</span>
                      <span>{inspectedDetail.analysis.preferredNames.join(', ')}</span>
                    </div>
                  )}

                  {inspectedDetail.availableOnly.length > 0 && (
                    <div className="flex items-center gap-1 text-stone-600">
                      <Check className="w-3 h-3 text-stone-900" aria-hidden="true" />
                      <span className="font-medium text-stone-900">Available:</span>
                      <span>{inspectedDetail.availableOnly.join(', ')}</span>
                    </div>
                  )}

                  {inspectedDetail.analysis.ifNeededNames.length > 0 && (
                    <div className="flex items-center gap-1 text-stone-600">
                      <HelpCircle className="w-3 h-3 text-stone-900" aria-hidden="true" />
                      <span className="font-medium text-stone-900">If needed:</span>
                      <span>{inspectedDetail.analysis.ifNeededNames.join(', ')}</span>
                    </div>
                  )}

                  {inspectedDetail.analysis.unavailableNames.length > 0 && (
                    <div className="flex items-center gap-1 text-stone-600">
                      <X className="w-3 h-3" aria-hidden="true" />
                      <span>Busy:</span>
                      <span>{inspectedDetail.analysis.unavailableNames.join(', ')}</span>
                    </div>
                  )}
              </div>
            )}

            {!inspectedDetail && (
              <div className="flex items-center gap-2 text-stone-500 italic">
                <Users className="w-4 h-4 text-stone-500" aria-hidden="true" />
                Every slot shown is a proposal from the organizer. Hover or click one to see who can attend, preferred votes, and lock the agreed time.
              </div>
            )}
          </div>

          {onFinalizeSlot && pinnedDetail && pinnedMeetingWindow && !pinnedDetail.isConfirmed && (
            <button
              id="quick-finalize-hover-slot"
              type="button"
              onClick={() =>
                onFinalizeSlot(
                  pinnedDetail.analysis.date,
                  pinnedDetail.analysis.timeStr,
                  pinnedMeetingWindow.endTime
                )
              }
              className="edu-btn-primary shrink-0"
              title={`Meeting: ${formatTimeSlot(pinnedMeetingWindow.startTime)} – ${formatTimeSlot(pinnedMeetingWindow.endTime)} (${poll.durationMinutes} min)`}
            >
              <CalendarCheck className="w-3.5 h-3.5" aria-hidden="true" />
              Agree on this timing
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
