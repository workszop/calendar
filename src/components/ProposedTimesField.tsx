import React, { useEffect, useState } from 'react';
import type { ProposalDraft } from '../hooks/useProposalDraft';
import { DRAFT_SLOT_INTERVAL } from '../hooks/useProposalDraft';
import { HourSelect } from './HourSelect';
import { ProposalGrid } from './ProposalGrid';

// ─── Types ───
export interface ProposedTimesFieldProps {
  draft: ProposalDraft;
  /** Unique prefix for element ids, so two forms never collide. */
  idPrefix: string;
  error?: string;
  /** Called on any edit, e.g. to clear the error. */
  onEdit?: () => void;
  /** Keep the common hour range visible and hide exact proposals in a disclosure. */
  collapsed?: boolean;
}

// ─── Component ───
/** Hour range selects plus the drag grid for the draft's selected dates. */
export const ProposedTimesField: React.FC<ProposedTimesFieldProps> = ({
  draft,
  idPrefix,
  error,
  onEdit,
  collapsed = false,
}) => {
  const errorId = `${idPrefix}-hours-error`;
  const [fineTuneOpen, setFineTuneOpen] = useState(false);

  // A failed submit must reveal the exact proposal controls, even when the
  // page intentionally keeps them collapsed for the common path.
  useEffect(() => {
    if (collapsed && error) setFineTuneOpen(true);
  }, [collapsed, error]);

  const changeRange = (start: number, end: number) => {
    draft.changeRange(start, end);
    onEdit?.();
  };

  const explanation = draft.selectedDates.length > 0 && (
    <p className="text-xs text-stone-500">
      Drag across the grid to add or remove times. Start on a selected slot to remove, on an
      empty one to add. Click a day to toggle all of it. Gaps are fine.
    </p>
  );

  const grid = (
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
  );

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
      {collapsed ? (
        <details
          className="d-create-fine-tune"
          open={fineTuneOpen}
          onToggle={() => setFineTuneOpen((open) => !open)}
        >
          <summary>Fine-tune individual days (optional)</summary>
          <div className="d-create-fine-tune-body">
            {explanation}
            {grid}
          </div>
        </details>
      ) : (
        <>
          {explanation}
          {grid}
        </>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-red-700 mt-1">
          {error}
        </p>
      )}
    </fieldset>
  );
};
