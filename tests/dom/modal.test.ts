import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Modal } from '../../src/components/Modal';

afterEach(cleanup);

// A trigger inside #root, so the modal's inert handling is exercised the way
// the real app uses it: open, then close and assert focus came back.
function Harness({ dismissOnBackdrop }: { dismissOnBackdrop?: boolean }) {
  const [open, setOpen] = useState(false);
  return h(
    'div',
    null,
    h('button', { type: 'button', onClick: () => setOpen(true) }, 'Open'),
    h(Modal, {
      isOpen: open,
      onClose: () => setOpen(false),
      title: 'Test dialog',
      dismissOnBackdrop,
      children: h('button', { type: 'button' }, 'Inside'),
    })
  );
}

function renderInRoot(ui: React.ReactElement) {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  return render(ui, { container: root });
}

describe('Modal', () => {
  it('renders a labelled dialog when open', () => {
    render(h(Modal, { isOpen: true, onClose: () => {}, title: 'Test dialog', children: 'body' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('Test dialog')).toBeTruthy();
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(h(Modal, { isOpen: true, onClose, title: 'Test dialog', children: 'body' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the trigger after closing', () => {
    renderInRoot(h(Harness, null));
    const trigger = screen.getByText('Open') as HTMLButtonElement;
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.getElementById('root')?.hasAttribute('inert')).toBe(true);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.getElementById('root')?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('ignores backdrop mousedown when dismissOnBackdrop is false', () => {
    const onClose = vi.fn();
    render(h(Modal, { isOpen: true, onClose, title: 'Test dialog', dismissOnBackdrop: false, children: 'body' }));
    const overlay = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.mouseDown(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on backdrop mousedown by default', () => {
    const onClose = vi.fn();
    render(h(Modal, { isOpen: true, onClose, title: 'Test dialog', children: 'body' }));
    const overlay = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
