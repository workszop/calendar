import { useState } from 'react';
import type { Poll } from '../types';
import { formatDateHeading, toDateStr } from '../utils/calendar';
import { findDateWithoutMeetingFit, isValidHourWindow } from '../utils/consensus';
import { latestPollDate, MAX_POLL_DATES } from '../utils/limits';
import { getStoredUser, setStoredUser } from '../utils/storage';
import { useProposalDraft } from '../hooks/useProposalDraft';
import type { ProposalDraft } from '../hooks/useProposalDraft';

// ─── Constants ───
export const DEFAULT_CREATE_START_HOUR = 9;
export const DEFAULT_CREATE_END_HOUR = 17;
export const CREATE_POLL_DURATIONS = [15, 30, 45, 60, 90, 120] as const;

// ─── Types ───
export interface CreatePollFormErrors {
  title?: string;
  dates?: string;
  hours?: string;
  submit?: string;
}

export interface CreatePollFormValues {
  title: string;
  description: string;
  location: string;
  durationMinutes: number;
  creatorName: string;
  creatorEmail: string;
  draft: ProposalDraft;
}

export interface CreatePollFormController extends CreatePollFormValues {
  setTitle: (value: string) => void;
  setDescription: (value: string) => void;
  setLocation: (value: string) => void;
  setDurationMinutes: (value: number) => void;
  setCreatorName: (value: string) => void;
  setCreatorEmail: (value: string) => void;
  /** Reset every field while keeping this hook mounted. */
  reset: (options?: Partial<Omit<CreatePollFormValues, 'draft'>>) => void;
}

export interface CreatePollValidation {
  dates: string[];
  errors: CreatePollFormErrors;
}

// ─── Helpers ───
/** Candidate dates after today, Monday through Sunday, for the date presets. */
export function getNextDates(count: number, startOffset = 1): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + startOffset + i);
    return toDateStr(date);
  });
}

/** The next Monday through Friday, never the current week. */
export function getNextWeekDates(): string[] {
  const now = new Date();
  const daysUntilNextMonday = ((1 + 7 - now.getDay()) % 7) || 7;
  return Array.from({ length: 5 }, (_, i) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilNextMonday + i);
    return toDateStr(date);
  });
}

/** Validate the required title field independently for compatible callers. */
export function validateCreatePollTitle(title: string): Pick<CreatePollFormErrors, 'title'> {
  return title.trim() ? {} : { title: 'Give the meeting a title.' };
}

/**
 * What is wrong with the proposed times of a draft for these dates, or
 * undefined when they are usable: the hour window must be in order, every
 * date must propose something and, given a meeting length, hold a back-to-back
 * run as long as the meeting, judged as the server stores it (exact slots at
 * the draft's interval, no hour overrides). Shared by "New Poll" and "Add
 * Dates" so the two can never disagree.
 */
export function proposalHoursError(draft: ProposalDraft, dates: string[], durationMinutes?: number): string | undefined {
  const { startHour, endHour, slotInterval } = draft;
  if (!isValidHourWindow(startHour, endHour)) return 'Start hour must be earlier than end hour.';
  const emptyDay = draft.findEmptyDay(dates);
  if (emptyDay) return `${formatDateHeading(emptyDay).full}: propose at least one time.`;
  if (!durationMinutes) return undefined;
  const { proposedSlots } = draft.slotsFor(dates);
  const shortDay = findDateWithoutMeetingFit({ durationMinutes, slotInterval, startHour, endHour, proposedSlots }, dates);
  return shortDay
    ? `${formatDateHeading(shortDay).full}: propose at least ${durationMinutes} minutes of back-to-back times.`
    : undefined;
}

/**
 * Validate the complete creation draft and return the same future dates that
 * should be sent to the API. The create page uses
 * this function so empty-day and hour-window semantics cannot drift. With a
 * duration, every date must also hold a back-to-back run as long as the
 * meeting (the server rejects the poll otherwise).
 */
export function validateCreatePoll(
  values: Pick<CreatePollFormValues, 'title' | 'draft'> & Partial<Pick<CreatePollFormValues, 'durationMinutes'>>,
  todayStr = toDateStr(new Date())
): CreatePollValidation {
  const dates = values.draft.selectedDates.filter((date) => date >= todayStr);
  const errors: CreatePollFormErrors = validateCreatePollTitle(values.title);

  if (dates.length === 0) errors.dates = 'Select at least one candidate date.';
  else if (dates.length > MAX_POLL_DATES) errors.dates = `Choose at most ${MAX_POLL_DATES} dates.`;
  else if (dates.some((date) => date > latestPollDate(new Date()))) {
    errors.dates = 'Choose dates within the next year.';
  }

  const hours = proposalHoursError(values.draft, dates, values.durationMinutes);
  if (hours) errors.hours = hours;

  return { dates, errors };
}

/** Build the existing POST /api/polls shape, including sparse proposals. */
export function buildCreatePollPayload(
  values: CreatePollFormValues,
  dates: string[],
  timezone: string
): Partial<Poll> {
  const { proposedSlots, isFullRange } = values.draft.slotsFor(dates);
  return {
    title: values.title.trim(),
    description: values.description.trim(),
    location: values.location.trim(),
    durationMinutes: values.durationMinutes,
    startHour: values.draft.startHour,
    endHour: values.draft.endHour,
    proposedSlots: isFullRange ? undefined : proposedSlots,
    slotInterval: values.draft.slotInterval,
    dates,
    creatorName: values.creatorName.trim() || 'Organizer',
    creatorEmail: values.creatorEmail.trim(),
    timezone,
  };
}

/** Remember the organizer identity for the next poll. */
export function rememberCreatePollOrganizer(values: Pick<CreatePollFormValues, 'creatorName' | 'creatorEmail'>) {
  setStoredUser({
    name: values.creatorName.trim() || undefined,
    email: values.creatorEmail.trim() || undefined,
  });
}

// ─── Hook ───
/** Controlled form state for the create page. */
export function useCreatePollForm(initialLocation = '', initiallyEmpty = false): CreatePollFormController {
  const storedUser = getStoredUser();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState(initialLocation);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [creatorName, setCreatorName] = useState(storedUser.name);
  const [creatorEmail, setCreatorEmail] = useState(storedUser.email);
  const draft = useProposalDraft(DEFAULT_CREATE_START_HOUR, DEFAULT_CREATE_END_HOUR, initiallyEmpty);

  const reset = (options: Partial<Omit<CreatePollFormValues, 'draft'>> = {}) => {
    setTitle(options.title ?? '');
    setDescription(options.description ?? '');
    setLocation(options.location ?? initialLocation);
    setDurationMinutes(options.durationMinutes ?? 60);
    setCreatorName(options.creatorName ?? getStoredUser().name);
    setCreatorEmail(options.creatorEmail ?? getStoredUser().email);
    draft.reset(DEFAULT_CREATE_START_HOUR, DEFAULT_CREATE_END_HOUR);
  };

  return {
    title,
    description,
    location,
    durationMinutes,
    creatorName,
    creatorEmail,
    draft,
    setTitle,
    setDescription,
    setLocation,
    setDurationMinutes,
    setCreatorName,
    setCreatorEmail,
    reset,
  };
}
