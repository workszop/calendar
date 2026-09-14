import React, { useMemo, useState } from 'react';
import { CalendarDays, CheckCircle2, Clock3, Search, Users } from 'lucide-react';
import type { PollSummary } from '../types';
import { formatDateHeading } from '../utils/calendar';
import { ActionDock } from './ActionDock';
import './home-page.css';

// ─── Types ───

export interface HomePageProps {
  polls: PollSummary[];
  listError?: string | null;
  onRetry?: () => void;
  onCreatePoll: () => void;
  onOpenPoll: (pollId: string) => void;
}

type HomeFilter = 'open' | 'agreed' | 'all';

// ─── Helpers ───

function pollStatus(poll: PollSummary): 'open' | 'agreed' {
  return poll.finalizedSlot ? 'agreed' : 'open';
}

function firstPollDate(poll: PollSummary): string | null {
  return poll.finalizedSlot?.date ?? poll.dates[0] ?? null;
}

interface DateTileParts {
  day: string;
  month: string;
  accessible: string;
}

function dateTileParts(date: string): DateTileParts | null {
  const [year, month, day] = date.split('-').map(Number);
  const dateObject = new Date(year, month - 1, day);
  if (
    !Number.isFinite(dateObject.getTime()) ||
    dateObject.getFullYear() !== year ||
    dateObject.getMonth() !== month - 1 ||
    dateObject.getDate() !== day
  ) {
    return null;
  }

  const shortParts = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).formatToParts(dateObject);
  const monthPart = shortParts.find((part) => part.type === 'month')?.value;
  const accessible = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(dateObject);

  return {
    day: String(day),
    month: monthPart ?? String(month),
    accessible,
  };
}

function candidateDateLabel(poll: PollSummary): string {
  if (!poll.dates.length) return 'No dates proposed';
  if (poll.dates.length === 1) return '1 candidate date';
  return `${poll.dates.length} candidate dates`;
}

function nextActionLabel(poll: PollSummary): string {
  if (poll.finalizedSlot) return 'View meeting';
  return poll.participantsCount > 0 ? 'View poll' : 'Open & share';
}

// ─── Component ───

export const HomePage: React.FC<HomePageProps> = ({
  polls,
  listError = null,
  onRetry,
  onCreatePoll,
  onOpenPoll,
}) => {
  const [filter, setFilter] = useState<HomeFilter>('open');
  const [search, setSearch] = useState('');

  const visiblePolls = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return polls.filter((poll) => {
      const matchesFilter = filter === 'all' || pollStatus(poll) === filter;
      const haystack = `${poll.title} ${poll.description}`.toLocaleLowerCase();
      return matchesFilter && (!needle || haystack.includes(needle));
    });
  }, [filter, polls, search]);

  const clearSearch = () => {
    setSearch('');
    setFilter('all');
  };

  return (
    <section className="d-home-page" data-screen="home" data-home-filter={filter}>
      <header className="d-home-page-head">
        <div>
          <p className="d-home-kicker">Your workspace</p>
          <h1 className="d-home-title">Meetings</h1>
          <p className="d-home-lead">A shared place to find a time that works.</p>
        </div>
      </header>

      {listError && (
        <div className="d-home-error" role="alert">
          <p>{listError}</p>
          {onRetry && (
            <button type="button" className="edu-btn-secondary" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}

      {polls.length === 0 ? (
        listError ? (
          <section className="d-home-list-error" aria-labelledby="home-list-error-title">
            <h2 id="home-list-error-title">Meetings are unavailable</h2>
            <p>We could not load your meetings. Use Retry above to try again.</p>
          </section>
        ) : (
          <section className="d-home-empty" aria-labelledby="home-empty-title">
            <button
              type="button"
              className="d-home-empty-symbol"
              aria-label="Create a meeting"
              title="Create a meeting"
              onClick={onCreatePoll}
            >
              <span aria-hidden="true">＋</span>
            </button>
            <h2 id="home-empty-title">Your first meeting starts here.</h2>
            <p>Propose a few dates, share a link and let people mark when they’re free.</p>
            <p className="d-home-muted">No calendar to connect. No availability grid until there is a poll.</p>
          </section>
        )
      ) : (
        <>
          <div className="d-home-tools">
            <div className="d-home-segment" role="group" aria-label="Filter meetings">
              {(['open', 'agreed', 'all'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {value === 'open' ? 'Open' : value === 'agreed' ? 'Agreed' : 'All'}
                </button>
              ))}
            </div>
            <label className="d-home-search">
              <span className="sr-only">Find a meeting</span>
              <Search aria-hidden="true" />
              <input
                type="search"
                aria-label="Find a meeting"
                placeholder="Find a meeting"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>

          <div className="d-home-list" data-visible-count={visiblePolls.length}>
            {visiblePolls.length > 0 ? (
              visiblePolls.map((poll) => {
                const date = firstPollDate(poll);
                const heading = date ? formatDateHeading(date) : null;
                const tile = date ? dateTileParts(date) : null;
                const status = pollStatus(poll);
                return (
                  <article key={poll.id} className="d-home-poll-row" data-poll-id={poll.id}>
                    <div className="d-home-date-tile" data-date={date ?? undefined}>
                      <span aria-hidden="true">{heading?.weekday ?? '–'}</span>
                      <strong aria-hidden="true">{tile?.day ?? '–'}</strong>
                      <span aria-hidden="true">{tile?.month ?? 'No date'}</span>
                      <span className="sr-only">{tile?.accessible ?? 'No candidate date'}</span>
                    </div>

                    <div className="d-home-poll-copy">
                      <button
                        type="button"
                        className="d-home-poll-title"
                        onClick={() => onOpenPoll(poll.id)}
                      >
                        {poll.title}
                      </button>
                      <p className="d-home-meta">
                        <CalendarDays aria-hidden="true" />
                        {status === 'agreed' && poll.finalizedSlot
                          ? heading?.full
                          : candidateDateLabel(poll)}
                        <span aria-hidden="true">·</span>
                        <Clock3 aria-hidden="true" />
                        {poll.durationMinutes} min
                      </p>
                      <p className="d-home-meta">
                        {status === 'agreed'
                          ? 'The meeting time is confirmed.'
                          : poll.participantsCount > 0
                            ? 'Voting is open. Review responses as they arrive.'
                            : 'No responses yet. Share your poll to get started.'}
                      </p>
                    </div>

                    <div className="d-home-poll-status">
                      <span className={`d-home-status-pill ${status}`}>
                        {status === 'agreed' && <CheckCircle2 aria-hidden="true" />}
                        {status === 'agreed' ? 'Agreed' : 'Open'}
                      </span>
                      <span className="d-home-response-count">
                        <Users aria-hidden="true" />
                        {poll.participantsCount} {poll.participantsCount === 1 ? 'response' : 'responses'}
                      </span>
                    </div>

                    <button
                      type="button"
                      className="edu-btn-secondary d-home-next-action"
                      onClick={() => onOpenPoll(poll.id)}
                    >
                      {nextActionLabel(poll)}
                    </button>
                  </article>
                );
              })
            ) : (
              <div className="d-home-no-results">
                <h2>No matching meetings</h2>
                <p>Try a different name or show all meetings.</p>
                <button type="button" className="edu-btn-secondary" onClick={clearSearch}>
                  Clear search and show all
                </button>
              </div>
            )}
          </div>
        </>
      )}
      {(polls.length > 0 || !listError) && (
        <ActionDock label="Meeting actions" className="d-home-action-dock">
          <button type="button" data-primary-action="create-poll" className="edu-btn-primary d-home-create" onClick={onCreatePoll}>
            <span aria-hidden="true">＋</span> Create a poll
          </button>
        </ActionDock>
      )}
    </section>
  );
};
