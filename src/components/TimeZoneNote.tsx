import React from 'react';
import { Globe } from 'lucide-react';
import { describeTimeZoneDifference, getViewerTimeZone } from '../utils/calendar';

// ─── Poll time zone label ───
// Every grid shows wall-clock times in the poll's zone. This note names that
// zone and, for a viewer elsewhere, how far their own clock is from it.

interface TimeZoneNoteProps {
  timeZone: string;
  /** Defaults to the browser zone; tests pin it. */
  viewerTimeZone?: string;
  /** Defaults to now; the difference follows the offsets in force at this instant. */
  now?: Date;
}

export const TimeZoneNote: React.FC<TimeZoneNoteProps> = ({ timeZone, viewerTimeZone, now }) => {
  const viewer = viewerTimeZone ?? getViewerTimeZone();
  const hint = describeTimeZoneDifference(timeZone, viewer, now);
  return (
    <p className="d-calendar-timezone" data-timezone-note data-viewer-timezone={viewer}>
      <Globe className="d-calendar-timezone-icon" aria-hidden="true" />
      <span>
        Times in {timeZone}
        {hint && <span className="d-calendar-timezone-hint"> ({hint})</span>}
      </span>
    </p>
  );
};
