import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CreatePollModal } from '../../src/components/CreatePollModal';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function cell(key: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`[data-proposal-grid] [data-slot-key="${key}"]`);
  if (!found) throw new Error(`Missing proposal cell ${key}`);
  return found;
}

// React derives pointerenter from pointerout; jsdom has no PointerEvent.
function dragOver(from: HTMLElement, to: HTMLElement) {
  const out = new MouseEvent('pointerout', { bubbles: true, relatedTarget: to });
  Object.defineProperty(out, 'pointerType', { value: 'mouse' });
  fireEvent(from, out);
}

function renderModal() {
  const onCreatePoll = vi.fn().mockResolvedValue(undefined);
  render(h(CreatePollModal, { isOpen: true, onClose: () => {}, onCreatePoll, defaultTimezone: 'UTC' }));
  return onCreatePoll;
}

async function pickNextThreeDays(): Promise<string[]> {
  fireEvent.click(screen.getByRole('button', { name: 'Next 3 Days' }));
  const headers = await screen.findAllByRole('button', { name: /Toggle all proposed times/ });
  expect(headers).toHaveLength(3);
  const keys = [...document.querySelectorAll<HTMLElement>('[data-proposal-grid] [data-slot-key]')].map(
    (el) => el.dataset.slotKey!
  );
  return [...new Set(keys.map((k) => k.slice(0, 10)))];
}

describe('CreatePollModal proposal grid', () => {
  it('starts with no dates and proposes the full range for picked dates', async () => {
    const onCreatePoll = renderModal();
    expect(document.querySelector('[data-proposal-grid]')).toBeNull();

    const dates = await pickNextThreeDays();
    expect(cell(`${dates[0]}T09:00`).dataset.selected).toBe('true');
    expect(cell(`${dates[2]}T16:30`).dataset.selected).toBe('true');

    fireEvent.change(screen.getByLabelText(/Meeting Title/), { target: { value: 'Full' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Meeting Poll' }));
    await waitFor(() => expect(onCreatePoll).toHaveBeenCalled());
    // Untouched grid = plain hour window, no explicit slots.
    expect(onCreatePoll.mock.calls[0][0]).toMatchObject({ startHour: 9, endHour: 17, proposedSlots: undefined });
  });

  it('drag-removes a range, leaving a gap, and sends the exact slots', async () => {
    const onCreatePoll = renderModal();
    const [day1, day2, day3] = await pickNextThreeDays();

    // Start on a selected cell (so the stroke removes) and jump over 10:30-11:30.
    fireEvent.pointerDown(cell(`${day1}T10:00`), { pointerId: 1, pointerType: 'mouse', button: 0 });
    dragOver(cell(`${day1}T10:00`), cell(`${day2}T12:00`));
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'mouse', button: 0 });

    for (const date of [day1, day2]) {
      for (const time of ['10:00', '10:30', '11:00', '11:30', '12:00']) {
        expect(cell(`${date}T${time}`).dataset.selected).toBe('false');
      }
      expect(cell(`${date}T09:30`).dataset.selected).toBe('true');
      expect(cell(`${date}T12:30`).dataset.selected).toBe('true');
    }
    expect(cell(`${day3}T10:00`).dataset.selected).toBe('true');

    fireEvent.change(screen.getByLabelText(/Meeting Title/), { target: { value: 'Gaps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Meeting Poll' }));
    await waitFor(() => expect(onCreatePoll).toHaveBeenCalled());
    const sent = onCreatePoll.mock.calls[0][0].proposedSlots as Record<string, string[]>;
    expect(sent[day1]).toEqual(['09:00', '09:30', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30']);
    expect(sent[day3]).toHaveLength(16);
  });

  it('drags a rectangle from the origin and restores cells when it shrinks', async () => {
    renderModal();
    const [day1, day2] = await pickNextThreeDays();

    fireEvent.pointerDown(cell(`${day1}T11:00`), { pointerId: 1, pointerType: 'mouse', button: 0 });
    dragOver(cell(`${day1}T11:00`), cell(`${day2}T13:30`));
    // Diagonal rectangle: day1 13:30 is cleared even though the pointer never crossed it.
    expect(cell(`${day1}T13:30`).dataset.selected).toBe('false');
    dragOver(cell(`${day2}T13:30`), cell(`${day1}T12:00`));
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'mouse', button: 0 });

    expect(cell(`${day1}T12:00`).dataset.selected).toBe('false');
    expect(cell(`${day1}T13:30`).dataset.selected).toBe('true');
    expect(cell(`${day2}T11:00`).dataset.selected).toBe('true');
  });

  it('refuses to create a poll with a day that proposes no time', async () => {
    const onCreatePoll = renderModal();
    const [day1] = await pickNextThreeDays();
    fireEvent.click(screen.getAllByRole('button', { name: /Toggle all proposed times/ })[0]);
    expect(cell(`${day1}T09:00`).dataset.selected).toBe('false');

    fireEvent.change(screen.getByLabelText(/Meeting Title/), { target: { value: 'Empty day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Meeting Poll' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText(/propose at least one time/)).toBeTruthy();
    expect(onCreatePoll).not.toHaveBeenCalled();
  });
});
