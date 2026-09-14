import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ActionDock } from '../../src/components/ActionDock';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps the primary action inside its form and reserves its measured height', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 96 } as DOMRect);
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  const result = render(h('form', { onSubmit: submit }, h(ActionDock, {
    label: 'Save answer', children: h('button', { type: 'submit' }, 'Save'),
  })));
  expect(screen.getByRole('region', { name: 'Save answer' }).dataset.actionDock).toBe('fixed');
  expect(result.container.querySelector<HTMLElement>('[data-action-dock-spacer]')?.style.height).toBe('112px');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(submit).toHaveBeenCalledTimes(1);
  result.unmount();
  expect(document.documentElement.style.getPropertyValue('--action-dock-space')).toBe('');
});

it('follows the visible viewport above a keyboard and removes listeners on unmount', () => {
  const viewport = Object.assign(new EventTarget(), { height: 400, offsetTop: 10 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  const removeListener = vi.spyOn(viewport, 'removeEventListener');
  const result = render(h(ActionDock, { label: 'Create', children: 'Create poll' }));
  const dock = screen.getByRole('region', { name: 'Create' });
  expect(dock.style.bottom).toBe('390px');
  act(() => { viewport.height = 500; viewport.dispatchEvent(new Event('resize')); });
  expect(dock.style.bottom).toBe('290px');
  result.unmount();
  expect(removeListener).toHaveBeenCalledWith('resize', expect.any(Function));
  expect(removeListener).toHaveBeenCalledWith('scroll', expect.any(Function));
});

it('updates clearance when validation makes the bar taller', () => {
  let height = 80;
  let onResize = () => {};
  const disconnect = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { onResize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const result = render(h(ActionDock, { label: 'Answer', children: 'Save' }));
  act(() => { height = 130; onResize(); });
  expect(result.container.querySelector<HTMLElement>('[data-action-dock-spacer]')?.style.height).toBe('146px');
  expect(document.documentElement.style.getPropertyValue('--action-dock-space')).toBe('146px');
  result.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
