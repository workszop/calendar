import React from 'react';
import type { PollGrid } from '../hooks/usePollGrid';
import { formatTimeSlot } from '../utils/calendar';

// ─── Shared grid shell ───
// The painter and the heatmap draw the same table: a sticky Time column, one
// column per proposed date, and a blank cell wherever a date does not propose
// that time. Only the header content and the cell content differ, so both grids
// hand those in and this component owns the markup they share.

interface SlotTableProps {
  /** Column dates as YYYY-MM-DD, in display order. */
  dates: string[];
  timeSlots: PollGrid['timeSlots'];
  isProposed: PollGrid['isProposed'];
  dateHeadings: PollGrid['dateHeadings'];
  /** Replaces the plain weekday / day-month heading (the painter makes it a button). */
  renderHeader?: (date: string) => React.ReactNode;
  renderCell: (date: string, time: string) => React.ReactNode;
  /** Tailwind height of one cell, e.g. "h-10" - also sizes the blank spacers. */
  cellHeightClass: string;
  /** Extra props for the <table> element (the painter listens for pointermove here). */
  tableProps?: React.HTMLAttributes<HTMLTableElement>;
}

export const SlotTable: React.FC<SlotTableProps> = ({
  dates,
  timeSlots,
  isProposed,
  dateHeadings,
  renderHeader,
  renderCell,
  cellHeightClass,
  tableProps,
}) => (
  <div className="overflow-x-auto">
    <table {...tableProps} className="w-full border-collapse select-none">
      <thead>
        <tr className="bg-stone-50 border-b border-stone-200">
          <th className="sticky left-0 z-10 bg-stone-50 py-3 px-3 text-left text-xs font-semibold text-stone-500 uppercase tracking-wider font-mono w-24 border-r border-stone-200">
            Time
          </th>
          {dates.map((dateStr) => {
            const heading = dateHeadings.get(dateStr);
            return (
              <th
                key={dateStr}
                className="p-0 text-center min-w-[130px] border-r border-stone-200 last:border-r-0"
              >
                {renderHeader ? (
                  renderHeader(dateStr)
                ) : (
                  <div className="py-3 px-3">
                    <div className="text-xs font-semibold uppercase tracking-wider font-mono text-stone-500">
                      {heading?.weekday}
                    </div>
                    <div className="text-sm font-bold text-stone-900 mt-0.5">
                      {heading?.dayMonth}
                    </div>
                  </div>
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {timeSlots.map((timeStr) => (
          <tr key={timeStr} className="border-b border-stone-100 last:border-b-0">
            <td className="sticky left-0 z-10 bg-white py-2 px-3 text-xs font-medium text-stone-500 border-r border-stone-200 whitespace-nowrap">
              {formatTimeSlot(timeStr)}
            </td>

            {dates.map((dateStr) =>
              isProposed(dateStr, timeStr) ? (
                <td
                  key={dateStr}
                  className="p-1 border-r border-stone-200/60 last:border-r-0 text-center"
                >
                  {renderCell(dateStr, timeStr)}
                </td>
              ) : (
                <td
                  key={dateStr}
                  className="p-1 border-r border-stone-200/60 last:border-r-0"
                  aria-hidden="true"
                >
                  <div className={`w-full ${cellHeightClass}`} />
                </td>
              )
            )}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
