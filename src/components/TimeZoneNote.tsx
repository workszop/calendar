import React, { useMemo } from 'react';
import { Globe } from 'lucide-react';
import { describeTimeZoneDifference, getViewerTimeZone } from '../utils/calendar';

// ─── Poll time zone label ───
// Every grid shows wall-clock times in the poll's zone. This note names that
// zone and, for a viewer elsewhere, how far their own clock is from it on the
// poll's dates.

interface TimeZoneNoteProps {
  timeZone: string;
  /** The poll's dates: the difference follows the offsets in force on them. */
  dates?: readonly string[];
  /** Defaults to the browser zone; tests pin it. */
  viewerTimeZone?: string;
  /** Used only without dates: the offsets in force at this instant. */
  now?: Date;
}

export const TimeZoneNote: React.FC<TimeZoneNoteProps> = ({ timeZone, dates, viewerTimeZone, now }) => {
  const viewer = viewerTimeZone ?? getViewerTimeZone();
  // Painting re-renders the grid often; the poll's dates array stays the same.
  const hint = useMemo(() => describeTimeZoneDifference(timeZone, viewer, dates, now), [timeZone, viewer, dates, now]);
  return (
    <p className="d-calendar-timezone" data-timezone-note data-viewer-timezone={viewer}>
      <Globe className="d-calendar-timezone-icon" aria-hidden="true" />
      <span>
        Times in {timeZone}
        {hint && <span className="d-calendar-timezone-hint" data-timezone-hint>, {hint}</span>}
      </span>
    </p>
  );
};
