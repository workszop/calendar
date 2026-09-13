import React from 'react';
import type { ProposalDraft } from '../hooks/useProposalDraft';
import { DRAFT_SLOT_INTERVAL } from '../hooks/useProposalDraft';
import { HourSelect } from './HourSelect';
import { ProposalGrid } from './ProposalGrid';

// ─── Types ───
interface ProposedTimesFieldProps {
  draft: ProposalDraft;
  /** Unique prefix for element ids, so two forms never collide. */
  idPrefix: string;
  error?: string;
  /** Called on any edit, e.g. to clear the error. */
  onEdit?: () => void;
}

// ─── Component ───
/** Hour range selects plus the drag grid for the draft's selected dates. */
export const ProposedTimesField: React.FC<ProposedTimesFieldProps> = ({ draft, idPrefix, error, onEdit }) => {
  const errorId = `${idPrefix}-hours-error`;
  const changeRange = (start: number, end: number) => {
    draft.changeRange(start, end);
    onEdit?.();
  };

  return (
    <fieldset className="space-y-2">
      <legend className="edu-label">Proposed times</legend>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${idPrefix}-start-hour`} className="text-xs font-semibold text-stone-600">
            From
          </label>
          <HourSelect
            id={`${idPrefix}-start-hour`}
            value={draft.startHour}
            invalid={Boolean(error)}
            describedBy={error ? errorId : undefined}
            onChange={(h) => changeRange(h, draft.endHour)}
            className="edu-input"
          />
        </div>

        <div>
          <label htmlFor={`${idPrefix}-end-hour`} className="text-xs font-semibold text-stone-600">
            Until
          </label>
          <HourSelect
            id={`${idPrefix}-end-hour`}
            value={draft.endHour}
            invalid={Boolean(error)}
            describedBy={error ? errorId : undefined}
            onChange={(h) => changeRange(draft.startHour, h)}
            className="edu-input"
          />
        </div>
      </div>
      {draft.selectedDates.length > 0 && (
        <p className="text-xs text-stone-500">
          Drag across the grid to add or remove times. Start on a selected slot to remove, on an
          empty one to add. Click a day to toggle all of it. Gaps are fine.
        </p>
      )}
      <ProposalGrid
        dates={draft.selectedDates}
        times={draft.gridTimes}
        slotInterval={DRAFT_SLOT_INTERVAL}
        proposed={draft.proposed}
        onChange={(update) => {
          draft.setProposed(update);
          onEdit?.();
        }}
        invalid={Boolean(error)}
        describedBy={error ? errorId : undefined}
      />
      {error && (
        <p id={errorId} role="alert" className="text-xs text-red-700 mt-1">
          {error}
        </p>
      )}
    </fieldset>
  );
};
