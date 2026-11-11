import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadIcsFile } from '../../src/utils/calendar';
import { fileSafeName } from '../../src/utils/download';
import type { Poll } from '../../src/types';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const poll: Poll = {
  id: 'poll_ics',
  title: 'Team sync',
  description: '',
  durationMinutes: 30,
  timezone: 'UTC',
  dates: ['2026-10-01'],
  startHour: 9,
  endHour: 10,
  slotInterval: 30,
  creatorName: 'Ada',
  createdAt: '',
  finalizedSlot: null,
  participants: [],
};

describe('downloadIcsFile', () => {
  it('revokes the object URL only after the download has had time to start', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:ics');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadIcsFile(poll, { date: '2026-10-01', startTime: '09:00', endTime: '09:30', confirmedBy: 'Ada', confirmedAt: '' });

    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:ics');
  });
});

describe('fileSafeName', () => {
  it('keeps letters of any script and collapses everything else', () => {
    expect(fileSafeName('Team sync')).toBe('Team_sync');
    expect(fileSafeName('Zebranie zarządu')).toBe('Zebranie_zarządu');
    expect(fileSafeName('会議')).toBe('会議');
    expect(fileSafeName('Q3: plan / review!')).toBe('Q3_plan_review');
    expect(fileSafeName('???')).toBe('meeting');
  });
});
