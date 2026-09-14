import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MonthCalendar } from '../../src/components/MonthCalendar';

const originalInnerWidth = window.innerWidth;

type ResizeCallback = () => void;

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly callback: ResizeCallback;
  readonly observed: Element[] = [];
  readonly disconnect = vi.fn();

  constructor(callback: ResizeCallback) {
    this.callback = callback;
    TestResizeObserver.instances.push(this);
  }

  observe(element: Element) {
    this.observed.push(element);
  }

  trigger() {
    this.callback();
  }
}

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function installMeasurement(width: number) {
  let currentWidth = width;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.calendarHost !== undefined) {
      return { width: currentWidth, height: 0, top: 0, left: 0, right: currentWidth, bottom: 0 } as DOMRect;
    }
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } as DOMRect;
  });
  return {
    setWidth(nextWidth: number) {
      currentWidth = nextWidth;
    },
    resize() {
      const observer = TestResizeObserver.instances.at(-1);
      if (!observer) throw new Error('No calendar ResizeObserver was created');
      act(() => observer.trigger());
    },
  };
}

function installBrowserMocks() {
  TestResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('matchMedia', (query: string) => {
    const listeners = new Set<EventListener>();
    return {
      media: query,
      get matches() {
        return window.innerWidth <= 768;
      },
      addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
      addListener: (listener: EventListener) => listeners.add(listener),
      removeListener: (listener: EventListener) => listeners.delete(listener),
      dispatchEvent: (event: Event) => {
        listeners.forEach((listener) => listener(event));
        return true;
      },
    } as unknown as MediaQueryList;
  });
}

interface HarnessProps {
  width: number;
  responsive?: boolean;
  initialMonth?: Date;
  initialSelected?: string[];
  minDate?: string;
  lockedDates?: string[];
  invalid?: boolean;
  describedBy?: string;
  onToggle?: (date: string) => void;
}

function CalendarHarness({
  width,
  responsive,
  initialMonth = new Date(2026, 0, 1),
  initialSelected = [],
  minDate = '2026-01-01',
  lockedDates = [],
  invalid = false,
  describedBy,
  onToggle,
}: HarnessProps) {
  const [viewMonth, setViewMonth] = useState(initialMonth);
  const [selected, setSelected] = useState(initialSelected);

  const toggle = (date: string) => {
    setSelected((previous) =>
      previous.includes(date) ? previous.filter((candidate) => candidate !== date) : [...previous, date]
    );
    onToggle?.(date);
  };

  return h(
    'div',
    { 'data-calendar-host': true, style: { width: `${width}px` } },
    h(MonthCalendar, {
      selected,
      onToggle: toggle,
      minDate,
      viewMonth,
      onViewMonthChange: setViewMonth,
      invalid,
      describedBy,
      lockedDates,
      responsive,
    })
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  TestResizeObserver.instances = [];
  setViewport(originalInnerWidth);
});

describe('MonthCalendar responsive layout', () => {
  it('shows up to three months at 932px and keeps compact fallbacks', () => {
    installBrowserMocks();
    const measurement = installMeasurement(932);
    render(h(CalendarHarness, { width: 932, responsive: true, initialMonth: new Date(2026, 11, 1) }));
    const calendar = screen.getByRole('group', { name: 'Proposed dates' });
    expect(calendar.dataset.visibleMonths).toBe('3');
    expect([...calendar.querySelectorAll<HTMLElement>('[data-month]')].map(el => el.dataset.month))
      .toEqual(['2026-12', '2027-01', '2027-02']);
    expect(screen.getAllByRole('button', { name: 'Next month' })).toHaveLength(1);
    const ids = [...calendar.querySelectorAll('[id]')].map(el => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    measurement.setWidth(931);
    measurement.resize();
    expect(calendar.dataset.visibleMonths).toBe('2');
    measurement.setWidth(615);
    measurement.resize();
    expect(calendar.dataset.visibleMonths).toBe('1');
    measurement.setWidth(1400);
    measurement.resize();
    expect(calendar.dataset.visibleMonths).toBe('3');
    setViewport(768);
    measurement.resize();
    expect(calendar.dataset.visibleMonths).toBe('1');
  });

  it('keeps third-month selections and restores focus when that month disappears', () => {
    installBrowserMocks();
    const measurement = installMeasurement(932);
    render(h(CalendarHarness, { width: 932, responsive: true }));
    const march = screen.getByRole('button', { name: /^Sunday, March 1(?:,|$)/ });
    fireEvent.click(march);
    act(() => march.focus());
    measurement.setWidth(616);
    measurement.resize();
    expect(document.activeElement).toBe(document.querySelector('[data-date="2026-01-01"]'));
    measurement.setWidth(932);
    measurement.resize();
    expect(document.querySelector('[data-date="2026-03-01"]')?.getAttribute('aria-pressed')).toBe('true');
    const februaryLast = screen.getByRole('button', { name: /Saturday, February 28/ });
    act(() => februaryLast.focus());
    fireEvent.keyDown(februaryLast, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(document.querySelector('[data-date="2026-03-01"]'));
    expect(calendarMonths()).toEqual(['2026-01', '2026-02', '2026-03']);
    measurement.setWidth(615);
    measurement.resize();
    expect(document.activeElement).toBe(document.querySelector('[data-date="2026-01-01"]'));

    function calendarMonths() {
      return [...screen.getByRole('group', { name: 'Proposed dates' }).querySelectorAll<HTMLElement>('[data-month]')]
        .map(el => el.dataset.month);
    }
  });

  it('shows two consecutive months at 616px and one below the threshold', () => {
    installBrowserMocks();
    const measurement = installMeasurement(616);
    render(h(CalendarHarness, { width: 616, responsive: true }));

    const calendar = screen.getByRole('group', { name: 'Proposed dates' });
    expect(calendar.dataset.calendarMode).toBe('responsive');
    expect(calendar.dataset.visibleMonths).toBe('2');
    expect([...calendar.querySelectorAll<HTMLElement>('[data-month]')].map((month) => month.dataset.month)).toEqual([
      '2026-01',
      '2026-02',
    ]);

    measurement.setWidth(615);
    measurement.resize();
    expect(calendar.dataset.visibleMonths).toBe('1');
    expect(calendar.querySelectorAll('[data-month]')).toHaveLength(1);
  });

  it('always keeps one month when the viewport is at the mobile breakpoint', () => {
    installBrowserMocks();
    setViewport(768);
    installMeasurement(900);
    render(h(CalendarHarness, { width: 900, responsive: true }));

    const calendar = screen.getByRole('group', { name: 'Proposed dates' });
    expect(calendar.dataset.visibleMonths).toBe('1');
    expect(calendar.querySelectorAll('[data-month]')).toHaveLength(1);
  });

  it('keeps selected dates through resize and navigation, including a year rollover', () => {
    installBrowserMocks();
    const measurement = installMeasurement(616);
    render(
      h(CalendarHarness, {
        width: 616,
        responsive: true,
        initialMonth: new Date(2026, 11, 1),
        initialSelected: ['2026-12-31', '2027-01-01'],
      })
    );

    expect(document.querySelector<HTMLButtonElement>('[data-date="2026-12-31"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector<HTMLButtonElement>('[data-date="2027-01-01"]')?.getAttribute('aria-pressed')).toBe('true');

    measurement.setWidth(615);
    measurement.resize();
    expect(document.querySelector<HTMLButtonElement>('[data-date="2026-12-31"]')?.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('group', { name: 'Proposed dates' }).querySelector('[data-month]')?.getAttribute('data-month')).toBe(
      '2027-01'
    );
    expect(document.querySelector<HTMLButtonElement>('[data-date="2027-01-01"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('moves keyboard focus across visible months and then advances the window', () => {
    installBrowserMocks();
    installMeasurement(616);
    render(h(CalendarHarness, { width: 616, responsive: true }));

    const januaryLast = screen.getByRole('button', { name: /Saturday, January 31/ });
    fireEvent.focus(januaryLast);
    fireEvent.keyDown(januaryLast, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(document.querySelector('[data-date="2026-02-01"]'));
    expect(screen.getByRole('group', { name: 'Proposed dates' }).dataset.visibleMonths).toBe('2');

    const februaryLast = screen.getByRole('button', { name: /Saturday, February 28/ });
    fireEvent.focus(februaryLast);
    fireEvent.keyDown(februaryLast, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(document.querySelector('[data-date="2026-03-01"]'));
    expect([...screen.getByRole('group', { name: 'Proposed dates' }).querySelectorAll<HTMLElement>('[data-month]')].map(
      (month) => month.dataset.month
    )).toEqual(['2026-03', '2026-04']);
  });

  it('restores a visible date focus when resizing removes the focused month without stealing outside focus', () => {
    installBrowserMocks();
    const measurement = installMeasurement(616);
    render(h(CalendarHarness, { width: 616, responsive: true }));
    const februaryDate = document.querySelector<HTMLButtonElement>('[data-date="2026-02-01"]')!;
    act(() => februaryDate.focus());
    measurement.setWidth(615);
    measurement.resize();
    expect(document.activeElement).toBe(document.querySelector('[data-date="2026-01-01"]'));

    measurement.setWidth(616);
    measurement.resize();
    const next = screen.getByRole('button', { name: 'Next month' });
    act(() => next.focus());
    measurement.setWidth(615);
    measurement.resize();
    expect(document.activeElement).toBe(next);
  });

  it('keeps invalid state and past/locked date semantics in both months', () => {
    installBrowserMocks();
    installMeasurement(616);
    const onToggle = vi.fn();
    render(
      h(CalendarHarness, {
        width: 616,
        responsive: true,
        minDate: '2026-01-10',
        lockedDates: ['2026-01-12', '2026-02-01'],
        initialSelected: ['2026-01-05'],
        invalid: true,
        describedBy: 'calendar-error',
        onToggle,
      })
    );

    const calendar = screen.getByRole('group', { name: 'Proposed dates' });
    expect(calendar.getAttribute('aria-describedby')).toBe('calendar-error');
    expect(screen.getAllByRole('grid')).toHaveLength(2);
    expect(screen.getAllByRole('grid')[0].getAttribute('aria-invalid')).toBe('true');

    const locked = document.querySelector<HTMLButtonElement>('[data-date="2026-01-12"]');
    if (!locked) throw new Error('Missing locked date');
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    expect(locked.getAttribute('data-locked')).toBe('true');
    fireEvent.click(locked);
    expect(onToggle).not.toHaveBeenCalled();

    const pastSelected = document.querySelector<HTMLButtonElement>('[data-date="2026-01-05"]');
    if (!pastSelected) throw new Error('Missing selected past date');
    expect(pastSelected.getAttribute('aria-pressed')).toBe('true');
    expect(pastSelected.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(pastSelected);
    expect(onToggle).toHaveBeenCalledWith('2026-01-05');
  });

  it('uses one shared navigation pair and unique labels and date IDs for two months', () => {
    installBrowserMocks();
    installMeasurement(616);
    render(h(CalendarHarness, { width: 616, responsive: true }));

    const calendar = screen.getByRole('group', { name: 'Proposed dates' });
    expect(screen.getAllByRole('button', { name: 'Previous month' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Next month' })).toHaveLength(1);

    const ids = [...calendar.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(calendar.querySelectorAll('[id^="calendar-month-label-"]')).toHaveLength(2);
    expect(calendar.querySelectorAll('[id^="toggle-date-"]')).toHaveLength(59);
    expect(calendar.querySelectorAll('[role="grid"][aria-labelledby]')).toHaveLength(2);
  });
});

describe('MonthCalendar legacy mode', () => {
  it('defaults to one month and preserves the legacy IDs', () => {
    installBrowserMocks();
    installMeasurement(616);
    render(h(CalendarHarness, { width: 616 }));

    const calendar = screen.getByRole('group', { name: 'Proposed dates' });
    expect(calendar.dataset.calendarMode).toBe('single');
    expect(calendar.dataset.visibleMonths).toBe('1');
    expect(calendar.querySelectorAll('[data-month]')).toHaveLength(1);
    expect(calendar.querySelectorAll('#calendar-prev-month')).toHaveLength(1);
    expect(calendar.querySelectorAll('#calendar-next-month')).toHaveLength(1);
    expect(calendar.querySelectorAll('#calendar-month-label')).toHaveLength(1);
  });
});
