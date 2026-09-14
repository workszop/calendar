import { Component, type ErrorInfo, type ReactNode } from 'react';

// ─── Error boundary ───
// Last line of defence: an unexpected render error shows a recoverable message
// instead of a blank page.

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unexpected app error:', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <main role="alert" data-screen="crashed" className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="mb-3 text-2xl font-semibold">Something went wrong</h1>
        <p className="mb-6">This page could not be displayed. Your saved answers are not affected.</p>
        <button type="button" className="edu-btn-primary" onClick={() => window.location.assign('/')}>
          Back to all meetings
        </button>
      </main>
    );
  }
}
