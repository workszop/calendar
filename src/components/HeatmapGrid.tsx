import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, CalendarCheck, CalendarDays, Check, Filter, HelpCircle, Lock, Star, Users, X } from 'lucide-react';
import type { Poll, SlotAnalysis } from '../types';
import { formatTimeSlot } from '../utils/calendar';
import { getMeetingWindow, slotKey } from '../utils/consensus';
import { analyzeGridBlock, getBlockStatus, type GridInterval } from '../utils/grid';
import { usePollGrid } from '../hooks/usePollGrid';
import { ActionDock } from './ActionDock';
import { SlotTable } from './SlotTable';
import './calendar-workspace.css';

interface MeetingAttendance {
  availableNames: string[];
  preferredNames: string[];
  ifNeededNames: string[];
  unavailableNames: string[];
  availableCount: number;
}

/**
 * A display cell can be shorter than the meeting duration. Keep the cell
 * analysis for local context, but calculate this separate summary for the
 * exact meeting window used by the finalization action.
 */
function analyzeMeetingAttendance(poll: Poll, date: string, slotTimes: string[]): MeetingAttendance {
  const availableNames: string[] = [];
  const preferredNames: string[] = [];
  const ifNeededNames: string[] = [];
  const unavailableNames: string[] = [];

  poll.participants.forEach((participant) => {
    const statuses = slotTimes.map((time) => participant.availability[slotKey(date, time)]);
    const allPreferred = statuses.length > 0 && statuses.every((status) => status === 'preferred');
    const allAvailable = statuses.length > 0 && statuses.every((status) => status === 'preferred' || status === 'available');
    const allPossible = statuses.length > 0 && statuses.every(
      (status) => status === 'preferred' || status === 'available' || status === 'if_needed'
    );

    if (allPreferred) {
      preferredNames.push(participant.name);
      availableNames.push(participant.name);
    } else if (allAvailable) {
      availableNames.push(participant.name);
    } else if (allPossible) {
      ifNeededNames.push(participant.name);
    } else {
      unavailableNames.push(participant.name);
    }
  });

  return {
    availableNames,
    preferredNames,
    ifNeededNames,
    unavailableNames,
    availableCount: availableNames.length,
  };
}

interface HeatmapGridProps {
  poll: Poll;
  gridInterval?: GridInterval;
  /** Only supplied when finalizing is allowed; the agree button hides without it. */
  onFinalizeSlot?: (date: string, startTime: string, endTime: string) => void;
  activeParticipantFilter: string | null;
  onSelectParticipantFilter: (id: string | null) => void;
}

// ─── Cell ───

interface HeatCellProps {
  analysis: SlotAnalysis;
  className: string;
  label: string;
  isPinned: boolean;
  isInspected: boolean;
  isFinalized: boolean;
  /** The filtered participant's own answer, or null when showing the group heatmap. */
  ownAnswer: string | null;
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
  onHover,
  onFocus,
  onPin,
}) {
  const stateClass = isPinned
    ? 'd-calendar-cell--pinned'
    : isInspected
      ? 'd-calendar-cell--inspected'
      : '';

  return (
    <button
      id={`slot-${analysis.date}-${analysis.timeStr}`}
      type="button"
      data-slot-key={analysis.slotKey}
      data-count={analysis.availableCount}
      data-finalized={isFinalized ? 'true' : 'false'}
      aria-label={label}
      aria-pressed={isPinned}
      onClick={() => onPin(analysis.slotKey)}
      onMouseEnter={() => onHover(analysis.slotKey)}
      onFocus={() => onFocus(analysis.slotKey)}
      className={`d-calendar-cell ${className} ${stateClass}`}
    >
      {isFinalized ? (
        <span className="d-calendar-cell-label">
          <Lock className="d-calendar-cell-icon" aria-hidden="true" />
          Confirmed
        </span>
      ) : ownAnswer !== null ? (
        <span className="d-calendar-cell-label">{ownAnswer}</span>
      ) : (
        <span className="d-calendar-cell-label">
          {analysis.availableCount}
          {analysis.preferredCount > 0 && (
            <Star className="d-calendar-cell-icon" fill="currentColor" aria-hidden="true" />
          )}
        </span>
      )}
    </button>
  );
});

// ─── Heatmap ───

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
  const hasResponses = totalParticipants > 0;
  const hasProposals = blocks.size > 0;

  // A different poll or display grouping shares none of these keys.
  useEffect(() => {
    setHoveredKey(null);
    setPinnedKey(null);
    setFocusedKey(null);
  }, [poll.id, gridInterval]);

  // ─── Derived data ───
  const analyses = useMemo(() => {
    const map = new Map<string, SlotAnalysis>();
    blocks.forEach((block, key) => map.set(key, analyzeGridBlock(poll, block)));
    return map;
  }, [poll, blocks]);

  const filteredParticipant = activeParticipantFilter
    ? poll.participants.find((participant) => participant.id === activeParticipantFilter) ?? null
    : null;

  const getParticipantCellClass = (status: string): string => {
    switch (status) {
      case 'preferred':
        return 'd-calendar-cell--preferred';
      case 'available':
        return 'd-calendar-cell--available';
      case 'if_needed':
        return 'd-calendar-cell--if-needed';
      case 'unavailable':
        return 'd-calendar-cell--unavailable';
      case 'mixed':
        return 'd-calendar-cell--mixed';
      default:
        return 'd-calendar-cell--unanswered';
    }
  };

  const getHeatBgColor = (analysis: SlotAnalysis): string => {
    // A participant filter shows their one answer rather than inventing a group
    // count from the filtered view.
    if (filteredParticipant) {
      const block = blocks.get(analysis.slotKey);
      return getParticipantCellClass(block ? getBlockStatus(filteredParticipant.availability, block) : 'none');
    }

    const rate = totalParticipants > 0 ? analysis.availableCount / totalParticipants : 0;
    if (rate === 1) return 'd-calendar-cell--all';
    if (rate >= 0.75) return 'd-calendar-cell--high';
    if (rate >= 0.5) return 'd-calendar-cell--medium';
    if (rate >= 0.25) return 'd-calendar-cell--some';
    if (analysis.availableCount > 0) return 'd-calendar-cell--low';
    if (analysis.ifNeededCount > 0) return 'd-calendar-cell--if-needed';
    return 'd-calendar-cell--none';
  };

  const isSlotFinalized = (date: string, time: string) => {
    const block = blocks.get(slotKey(date, time));
    if (!poll.finalizedSlot || !block) return false;
    return (
      poll.finalizedSlot.date === date &&
      block.startTime < poll.finalizedSlot.endTime &&
      block.endTime > poll.finalizedSlot.startTime
    );
  };

  // A selected slot stays stable while the pointer explores other cells. Hover
  // remains a useful preview only before a cell is pinned by click.
  const inspectedKey = pinnedKey ?? focusedKey ?? hoveredKey;
  const inspected = inspectedKey ? analyses.get(inspectedKey) ?? null : null;

  // ─── Callbacks (stable, so HeatCell's memo holds) ───
  const handleHover = useCallback((key: string) => setHoveredKey(key), []);
  const handleFocus = useCallback((key: string) => setFocusedKey(key), []);
  const handlePin = useCallback(
    (key: string) => setPinnedKey((previous) => (previous === key ? null : key)),
    []
  );

  // Escape drops both the pinned and the transient inspected slot.
  const handleGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    setPinnedKey(null);
    setHoveredKey(null);
    setFocusedKey(null);
  };

  // ─── Inspector content ───
  const buildDetail = (analysis: SlotAnalysis) => {
    const dateHead = dateHeadings.get(analysis.date);
    const preferredSet = new Set(analysis.preferredNames);
    const meetingWindow = getMeetingWindow(poll, analysis.date, analysis.timeStr);
    const block = blocks.get(analysis.slotKey);
    return {
      analysis,
      dateHead,
      endTime: block?.endTime ?? analysis.timeStr,
      meetingWindow,
      meetingAttendance: meetingWindow
        ? analyzeMeetingAttendance(poll, analysis.date, meetingWindow.slotTimes)
        : null,
      isConfirmed: isSlotFinalized(analysis.date, analysis.timeStr),
      availableOnly: analysis.availableNames.filter((name) => !preferredSet.has(name)),
    };
  };

  const inspectedDetail = inspected ? buildDetail(inspected) : null;

  // Announced only when a cell is pinned or reached by keyboard. Mouse hover
  // sweeping the grid would make the live region unbearably chatty.
  const announcedKey = pinnedKey ?? focusedKey;
  const announced = announcedKey ? analyses.get(announcedKey) ?? null : null;
  const announcement = announced
    ? `${dateHeadings.get(announced.date)?.weekday ?? ''} ${
        dateHeadings.get(announced.date)?.dayMonth ?? ''
      }, ${announced.displayTime}: ${announced.availableCount} of ${totalParticipants} available` +
      (announced.preferredCount > 0 ? `, ${announced.preferredCount} preferred` : '')
    : '';

  // Finalizing acts on the pinned cell, never on whatever the pointer happens
  // to be over, and only when the parent allows it at all.
  const pinnedAnalysis = pinnedKey ? analyses.get(pinnedKey) ?? null : null;
  const pinnedDetail = pinnedAnalysis ? buildDetail(pinnedAnalysis) : null;
  const pinnedMeetingWindow = pinnedDetail?.meetingWindow ?? null;

  // ─── Render helpers ───
  const renderCell = (dateStr: string, timeStr: string) => {
    const key = slotKey(dateStr, timeStr);
    const analysis = analyses.get(key);
    const block = blocks.get(key);
    if (!analysis || !block) return null;

    const heading = dateHeadings.get(dateStr);
    const displayTime = `${formatTimeSlot(block.startTime)} – ${formatTimeSlot(block.endTime)}`;
    const blockStatus = filteredParticipant
      ? getBlockStatus(filteredParticipant.availability, block)
      : null;
    const ownAnswer = blockStatus
      ? blockStatus === 'none'
        ? 'No answer'
        : blockStatus === 'mixed'
          ? 'Mixed'
          : blockStatus === 'if_needed'
            ? 'If needed'
            : blockStatus === 'preferred'
              ? 'Preferred'
              : blockStatus === 'available'
                ? 'Available'
                : 'Busy'
      : null;

    const isFinalized = isSlotFinalized(dateStr, timeStr);
    const label = filteredParticipant
      ? `${heading?.weekday} ${heading?.dayMonth} ${displayTime}, ${filteredParticipant.name}: ${ownAnswer}`
      : `${heading?.weekday} ${heading?.dayMonth} ${displayTime}, ${analysis.availableCount} of ${totalParticipants} available` +
        (analysis.preferredCount > 0 ? `, preferred by ${analysis.preferredCount}` : '') +
        (isFinalized ? ', confirmed' : '');

    return (
      <HeatCell
        key={key}
        analysis={analysis}
        className={getHeatBgColor(analysis)}
        label={label}
        isPinned={pinnedKey === key}
        isInspected={inspectedKey === key}
        isFinalized={isFinalized}
        ownAnswer={ownAnswer}
        onHover={handleHover}
        onFocus={handleFocus}
        onPin={handlePin}
      />
    );
  };

  return (
    <div
      className="d-calendar-workspace"
      data-grid-interval={gridInterval ?? poll.slotInterval}
      data-calendar-state={!hasResponses ? 'empty' : !hasProposals ? 'no-proposals' : 'ready'}
      onKeyDown={handleGridKeyDown}
    >
      <div className="d-calendar-toolbar" data-visual-group="calendar-tools" aria-label="Calendar controls">
        {hasResponses && (
          <details className="d-calendar-disclosure">
            <summary>
              <span className="d-calendar-summary-label">
                <Filter
                  className="d-calendar-summary-icon"
                  data-visual-icon="filter"
                  aria-hidden="true"
                />
                <span>Filter responses</span>
              </span>
              {filteredParticipant && <span className="d-calendar-disclosure-badge">1 selected</span>}
            </summary>
            <div
              role="group"
              aria-labelledby="filter-view-label"
              className="d-calendar-disclosure-content d-calendar-filter-options"
            >
              <span id="filter-view-label" className="d-calendar-label">
                Show answers from
              </span>
              <button
                id="filter-everyone-btn"
                type="button"
                aria-pressed={activeParticipantFilter === null}
                onClick={() => onSelectParticipantFilter(null)}
                className={`d-calendar-filter-button ${
                  activeParticipantFilter === null ? 'd-calendar-filter-button--active' : ''
                }`}
              >
                Everyone ({totalParticipants})
              </button>

              {poll.participants.map((participant) => {
                const isSelected = activeParticipantFilter === participant.id;
                return (
                  <button
                    key={participant.id}
                    id={`filter-participant-${participant.id}`}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => onSelectParticipantFilter(isSelected ? null : participant.id)}
                    className={`d-calendar-filter-button ${
                      isSelected ? 'd-calendar-filter-button--active' : ''
                    }`}
                  >
                    {participant.name}
                  </button>
                );
              })}
            </div>
          </details>
        )}

        <details className="d-calendar-disclosure d-calendar-legend-disclosure">
          <summary>
            <span className="d-calendar-summary-label">
              <BookOpen
                className="d-calendar-summary-icon"
                data-visual-icon="legend"
                aria-hidden="true"
              />
              <span>How to read the calendar</span>
            </span>
          </summary>
          <div className="d-calendar-disclosure-content d-calendar-legend" aria-label="Calendar legend">
            <span className="d-calendar-legend-item">
              <span className="d-calendar-swatch d-calendar-swatch--none" aria-hidden="true" />
              No one available
            </span>
            <span className="d-calendar-legend-item">
              <span className="d-calendar-swatch d-calendar-swatch--some" aria-hidden="true" />
              Some available
            </span>
            <span className="d-calendar-legend-item">
              <span className="d-calendar-swatch d-calendar-swatch--all" aria-hidden="true" />
              Everyone available
            </span>
            <span className="d-calendar-legend-item">
              <Star className="d-calendar-legend-icon" fill="currentColor" aria-hidden="true" />
              Preferred votes
            </span>
          </div>
        </details>
      </div>

      {!hasResponses ? (
        <section className="d-calendar-empty" data-empty-results aria-labelledby="calendar-empty-title">
          <Users className="d-calendar-empty-icon" aria-hidden="true" />
          <h3 id="calendar-empty-title">No responses yet</h3>
          <p>Share this poll to collect availability. The group calendar will appear after someone responds.</p>
        </section>
      ) : !hasProposals ? (
        <section className="d-calendar-empty" data-empty-results aria-labelledby="calendar-no-proposals-title">
          <CalendarCheck className="d-calendar-empty-icon" aria-hidden="true" />
          <h3 id="calendar-no-proposals-title">No proposed times</h3>
          <p>The organizer has not added any candidate times to this poll.</p>
        </section>
      ) : (
        <div className="d-calendar-layout">
          <section
            className="d-calendar-grid-panel"
            data-visual-group="calendar-panel"
            aria-labelledby="calendar-grid-title"
          >
            <header className="d-calendar-panel-heading">
              <div>
                <p className="d-calendar-kicker">Group availability</p>
                <h3 id="calendar-grid-title">
                  <CalendarDays
                    className="d-calendar-panel-icon"
                    data-visual-icon="calendar"
                    aria-hidden="true"
                  />
                  <span>Find the overlap</span>
                </h3>
              </div>
              <p className="d-calendar-panel-note">Select a time to see who can attend.</p>
            </header>

            <div
              className="d-calendar-table-wrap"
              onMouseLeave={() => setHoveredKey(null)}
              data-calendar-grid
            >
              <SlotTable
                dates={poll.dates}
                timeSlots={timeSlots}
                isProposed={isProposed}
                dateHeadings={dateHeadings}
                renderCell={renderCell}
                cellHeightClass="d-calendar-cell-placeholder"
                tableProps={{ 'aria-label': 'Group availability grid' }}
              />
            </div>
          </section>

          <aside
            className="d-calendar-inspector"
            data-visual-group="selected-time"
            data-selected-slot={inspectedKey ?? undefined}
            aria-label="Selected time details"
          >
            <p className="d-calendar-kicker">Selected time</p>
            {inspectedDetail ? (
              <>
                <h3>
                  {inspectedDetail.dateHead?.weekday}, {inspectedDetail.dateHead?.dayMonth}
                </h3>
                <p className="d-calendar-inspector-time">
                  {inspectedDetail.analysis.displayTime} – {formatTimeSlot(inspectedDetail.endTime)}
                </p>
                <p className="d-calendar-inspector-count">
                  {inspectedDetail.analysis.availableCount} of {totalParticipants} available
                </p>

                <div className="d-calendar-people" aria-label="People for selected time">
                  {inspectedDetail.analysis.preferredNames.length > 0 && (
                    <div className="d-calendar-person-list">
                      <div className="d-calendar-person-status">
                        <Star className="d-calendar-person-icon" fill="currentColor" aria-hidden="true" />
                        Preferred
                      </div>
                      <span>{inspectedDetail.analysis.preferredNames.join(', ')}</span>
                    </div>
                  )}
                  {inspectedDetail.availableOnly.length > 0 && (
                    <div className="d-calendar-person-list">
                      <div className="d-calendar-person-status">
                        <Check className="d-calendar-person-icon" aria-hidden="true" />
                        Available
                      </div>
                      <span>{inspectedDetail.availableOnly.join(', ')}</span>
                    </div>
                  )}
                  {inspectedDetail.analysis.ifNeededNames.length > 0 && (
                    <div className="d-calendar-person-list">
                      <div className="d-calendar-person-status">
                        <HelpCircle className="d-calendar-person-icon" aria-hidden="true" />
                        If needed
                      </div>
                      <span>{inspectedDetail.analysis.ifNeededNames.join(', ')}</span>
                    </div>
                  )}
                  {inspectedDetail.analysis.unavailableNames.length > 0 && (
                    <div className="d-calendar-person-list">
                      <div className="d-calendar-person-status">
                        <X className="d-calendar-person-icon" aria-hidden="true" />
                        Busy
                      </div>
                      <span>{inspectedDetail.analysis.unavailableNames.join(', ')}</span>
                    </div>
                  )}
                </div>

                {inspectedDetail.isConfirmed && <p className="d-calendar-confirmed">This time is confirmed.</p>}

                {inspectedDetail.meetingWindow && inspectedDetail.meetingAttendance && (
                  <div
                    className="d-calendar-meeting-preview"
                    data-meeting-window-preview
                    data-visual-group="meeting-window"
                  >
                    <p className="d-calendar-kicker">Full meeting window</p>
                    <p className="d-calendar-meeting-range" data-meeting-window-range>
                      {formatTimeSlot(inspectedDetail.meetingWindow.startTime)} –{' '}
                      {formatTimeSlot(inspectedDetail.meetingWindow.endTime)}
                    </p>
                    <p className="d-calendar-meeting-count" data-meeting-window-count>
                      {inspectedDetail.meetingAttendance.availableCount} of {totalParticipants} available for full meeting
                    </p>
                    {inspectedDetail.meetingAttendance.availableNames.length > 0 && (
                      <p className="d-calendar-meeting-attendees">
                        Can attend: {inspectedDetail.meetingAttendance.availableNames.join(', ')}
                      </p>
                    )}
                    {inspectedDetail.meetingAttendance.ifNeededNames.length > 0 && (
                      <p className="d-calendar-meeting-attendees">
                        If needed: {inspectedDetail.meetingAttendance.ifNeededNames.join(', ')}
                      </p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="d-calendar-inspector-empty">
                Choose a cell to see the respondents and the exact meeting window.
              </p>
            )}

            <span aria-live="polite" className="sr-only">
              {announcement}
            </span>

          </aside>
        </div>
      )}

      {onFinalizeSlot && pinnedDetail && pinnedMeetingWindow && pinnedDetail.meetingAttendance && !pinnedDetail.isConfirmed && (
        <ActionDock label="Finalize selected timing" className="d-calendar-finalize-dock">
          <div className="d-calendar-finalize-content" data-visual-group="finalize-timing">
            <div className="d-calendar-finalize-summary" data-finalize-summary>
              <div className="d-calendar-finalize-heading">
                <strong
                  className="d-calendar-finalize-date"
                  data-finalize-date={pinnedDetail.analysis.date}
                  data-selected-date={pinnedDetail.analysis.date}
                >
                  {pinnedDetail.dateHead?.weekday}, {pinnedDetail.dateHead?.dayMonth}
                </strong>
                <span className="d-calendar-finalize-range" data-meeting-window-range>
                  {formatTimeSlot(pinnedMeetingWindow.startTime)} – {formatTimeSlot(pinnedMeetingWindow.endTime)}
                </span>
              </div>
              <span className="d-calendar-finalize-count" data-meeting-window-count>
                {pinnedDetail.meetingAttendance.availableCount} of {totalParticipants} available for full meeting
              </span>
            </div>
            <button
              id="quick-finalize-hover-slot"
              data-finalize-slot={pinnedDetail.analysis.slotKey}
              type="button"
              onClick={() =>
                onFinalizeSlot(
                  pinnedDetail.analysis.date,
                  pinnedDetail.analysis.timeStr,
                  pinnedMeetingWindow.endTime
                )
              }
              className="d-calendar-primary-action"
              title={`Meeting: ${formatTimeSlot(pinnedMeetingWindow.startTime)} – ${formatTimeSlot(
                pinnedMeetingWindow.endTime
              )} (${poll.durationMinutes} min)`}
            >
              <CalendarCheck className="d-calendar-action-icon" aria-hidden="true" />
              Agree on this timing
            </button>
          </div>
        </ActionDock>
      )}
    </div>
  );
};
