import React, { useMemo } from 'react';
import { Award, CheckCircle2, Star, Clock, CalendarCheck, Users } from 'lucide-react';
import type { Poll } from '../types';
import { formatDateHeading } from '../utils/calendar';
import { findBestMeetingWindows } from '../utils/consensus';
import type { MeetingWindowOption } from '../utils/consensus';

interface ConsensusPanelProps {
  poll: Poll;
  /** Only the organizer gets this; visitors see who can agree a time instead. */
  onFinalizeSlot?: (date: string, startTime: string, endTime: string) => void;
  /** A lock request is on its way: the agree controls wait for it. */
  isFinalizing?: boolean;
}

export const ConsensusPanel: React.FC<ConsensusPanelProps> = ({ poll, onFinalizeSlot, isFinalizing = false }) => {
  const options = useMemo(() => findBestMeetingWindows(poll), [poll]);
  const total = poll.participants.length;
  const canFinalize = Boolean(onFinalizeSlot) && !poll.finalizedSlot;
  // Why a time cannot be agreed here: the poll is locked, or this viewer is not the organizer.
  const lockedLabel = poll.finalizedSlot ? 'Voting is locked' : 'Only the organizer can agree a time';
  const lockedState = poll.finalizedSlot ? 'locked' : 'visitor';

  if (total === 0) {
    return (
      <div className="bg-white border border-stone-200 rounded-2xl p-8 text-center shadow-xs">
        <Users className="w-12 h-12 text-stone-300 mx-auto mb-3" />
        <h3 className="text-base font-bold text-stone-800">No Responses Yet</h3>
        <p className="text-stone-500 text-xs mt-1 max-w-md mx-auto">
          Share the invite link or fill out your availability above to calculate consensus and find
          the best meeting time.
        </p>
      </div>
    );
  }

  const topOption = options[0];
  const otherOptions = options.slice(1, 6); // next 5
  const topPreferred = new Set(topOption?.preferredAttendees ?? []);

  const isConfirmed = (opt: MeetingWindowOption) => {
    return (
      poll.finalizedSlot &&
      poll.finalizedSlot.date === opt.date &&
      poll.finalizedSlot.startTime === opt.startTime
    );
  };

  return (
    <div className="space-y-5">
      {/* Top Best Recommendation */}
      {topOption && (
        <div className="bg-white border border-stone-200 rounded-2xl p-6 shadow-xs">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-yellow-500 text-yellow-950 text-xs font-bold rounded-full uppercase tracking-wider font-mono">
                  <Award className="w-3.5 h-3.5" />
                  #1 Recommended Timing
                </span>
                {topOption.allAvailable ? (
                  <span className="inline-flex items-center gap-1 text-xs font-bold bg-green-500 text-white px-2.5 py-1 rounded-full">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    100% Group Consensus ({total}/{total})
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-stone-700 bg-stone-100 px-2.5 py-1 rounded-full">
                    {topOption.percentage}% Agreement ({topOption.availableCount}/{total})
                  </span>
                )}
              </div>

              {/* Date and Time Header */}
              {(() => {
                const dateHeading = formatDateHeading(topOption.date);
                return (
                  <div>
                    <h3 className="text-2xl font-black text-stone-900 tracking-tight">
                      {dateHeading.full}
                    </h3>
                    <div className="flex items-center gap-3 text-stone-700 font-semibold text-base mt-0.5">
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="w-4 h-4" />
                        {topOption.displayRange} ({poll.durationMinutes} min)
                      </span>
                      <span className="text-xs font-medium text-stone-500" data-option-timezone>
                        ({poll.timezone})
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* Attendees breakdown */}
              <div className="pt-2 space-y-1 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-stone-600">Can Attend:</span>
                  {topOption.availableAttendees.map((name, index) => (
                    <span
                      key={`${name}-${index}`}
                      className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-green-500 text-white text-[12px] font-bold rounded-md"
                    >
                      {topPreferred.has(name) && (
                        <Star className="w-3 h-3 text-white fill-white" />
                      )}
                      {name}
                    </span>
                  ))}
                </div>

                {topOption.ifNeededAttendees.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-stone-600">If Needed:</span>
                    {topOption.ifNeededAttendees.map((name, index) => (
                      <span
                        key={`${name}-${index}`}
                        className="px-2 py-0.5 bg-yellow-500 text-yellow-950 rounded-md font-medium"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                )}

                {topOption.unavailableAttendees.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-stone-500">Busy:</span>
                    {topOption.unavailableAttendees.map((name, index) => (
                      <span
                        key={`${name}-${index}`}
                        className="px-2 py-0.5 bg-stone-100 text-stone-500 rounded-md line-through"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Finalize button */}
            <div className="shrink-0 flex flex-col gap-2">
              {isConfirmed(topOption) ? (
                <div className="inline-flex items-center gap-2 px-4 py-2.5 bg-green-500 text-white text-xs font-bold rounded-full">
                  <CheckCircle2 className="w-4 h-4" />
                  Currently Selected & Agreed
                </div>
              ) : canFinalize ? (
                <button
                  id="finalize-top-option-btn"
                  type="button"
                  disabled={isFinalizing}
                  aria-busy={isFinalizing}
                  data-finalizing={isFinalizing ? 'true' : 'false'}
                  onClick={() => onFinalizeSlot?.(topOption.date, topOption.startTime, topOption.endTime)}
                  className="edu-btn-primary"
                >
                  <CalendarCheck className="w-4 h-4" />
                  {isFinalizing ? 'Locking...' : 'Agree on this time'}
                </button>
              ) : (
                <span
                  role="status"
                  data-consensus-lock={lockedState}
                  className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-100 text-stone-600 text-xs font-bold rounded-full"
                >
                  {lockedLabel}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Alternative Top Options */}
      {otherOptions.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold text-stone-500 uppercase tracking-wider font-mono">
              Other High-Consensus Alternative Times
            </h4>
            <span className="text-xs text-stone-500">Ranked by attendees & preferred votes</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {otherOptions.map((opt, idx) => {
              const dateHeading = formatDateHeading(opt.date);
              const confirmed = isConfirmed(opt);

              return (
                <div
                  key={`${opt.date}-${opt.startTime}`}
                  className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs hover:border-stone-300 transition-colors flex flex-col justify-between gap-3"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="text-xs font-bold text-stone-500">Rank #{idx + 2}</span>
                      <span
                        className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                          opt.percentage === 100
                            ? 'bg-green-500 text-white'
                            : opt.percentage >= 75
                            ? 'bg-blue-500 text-white'
                            : 'bg-stone-100 text-stone-700'
                        }`}
                      >
                        {opt.availableCount}/{total} can attend ({opt.percentage}%)
                      </span>
                    </div>

                    <div className="text-base font-bold text-stone-900">
                      {dateHeading.weekday}, {dateHeading.dayMonth}
                    </div>
                    <div className="text-xs font-medium text-stone-700 flex items-center gap-1 mt-0.5">
                      <Clock className="w-3.5 h-3.5" />
                      {opt.displayRange}
                      <span className="text-stone-500" data-option-timezone>
                        ({poll.timezone})
                      </span>
                    </div>

                    {/* Attendees count details */}
                    <div className="mt-2 text-xs text-stone-600 flex flex-wrap gap-1">
                      {opt.availableAttendees.map((name, index) => (
                        <span
                          key={`${name}-${index}`}
                          className="px-1.5 py-0.5 bg-stone-100 text-stone-700 rounded text-[11px]"
                        >
                          {name}
                        </span>
                      ))}
                      {opt.unavailableAttendees.length > 0 && (
                        <span className="text-[11px] text-stone-500 font-medium">
                          Busy: {opt.unavailableAttendees.join(', ')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="pt-2 border-t border-stone-100 flex items-center justify-end">
                    {confirmed ? (
                      <span className="text-xs font-bold text-stone-900 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Confirmed
                      </span>
                    ) : canFinalize ? (
                      <button
                        id={`select-alternative-btn-${opt.date}-${opt.startTime}`}
                        type="button"
                        disabled={isFinalizing}
                        onClick={() => onFinalizeSlot?.(opt.date, opt.startTime, opt.endTime)}
                        className="text-xs font-bold text-stone-900 hover:underline inline-flex items-center gap-1"
                      >
                        Choose this slot →
                      </button>
                    ) : (
                      <span className="text-xs font-bold text-stone-500" data-consensus-lock={lockedState}>{lockedLabel}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
