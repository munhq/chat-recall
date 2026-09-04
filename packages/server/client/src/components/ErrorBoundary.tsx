import React from 'react';

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', color: 'var(--cr-fg-1)', textAlign: 'center' }}>
          <h2 style={{ color: 'var(--cr-err-500)' }}>Something went wrong</h2>
          <p style={{ color: 'var(--cr-fg-2)' }}>{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: '1rem', padding: '0.5rem 1rem',
              background: 'var(--cr-brand-500)', border: 'none', borderRadius: 0,
              color: 'var(--cr-on-brand)', cursor: 'pointer',
            }}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
