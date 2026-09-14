import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './action-dock.css';

interface ActionDockProps {
  children: ReactNode;
  label: string;
  className?: string;
}

/** Stays in its original form tree; the spacer keeps the last content reachable. */
export function ActionDock({ children, label, className = '' }: ActionDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState(120);
  const [bottom, setBottom] = useState(0);

  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const root = document.documentElement;
    const previousSpace = root.style.getPropertyValue('--action-dock-space');
    const viewport = window.visualViewport;
    const measure = () => {
      const height = Math.ceil(dock.getBoundingClientRect().height) + 16;
      setSpace(height);
      root.style.setProperty('--action-dock-space', `${height}px`);
      setBottom(viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0);
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(dock);
    window.addEventListener('resize', measure);
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
      if (previousSpace) root.style.setProperty('--action-dock-space', previousSpace);
      else root.style.removeProperty('--action-dock-space');
    };
  }, []);

  return (
    <>
      <div data-action-dock-spacer aria-hidden="true" style={{ height: space }} />
      <div
        ref={dockRef}
        role="region"
        aria-label={label}
        data-action-dock="fixed"
        className={`d-action-dock ${className}`}
        style={{ bottom }}
      >
        {children}
      </div>
    </>
  );
}
