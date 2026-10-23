import { Component, type ReactNode } from 'react';

interface State {
  readonly failed: boolean;
}

/**
 * Around the lazily loaded help screen: a chunk that fails to load (a tab left open across a deploy, a dropped
 * connection) says so and offers a reload, instead of leaving the app blank.
 */
export class HelpLoadBoundary extends Component<{ readonly children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error('help pages failed to load', error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="help" data-testid="help-load-failed">
        <div className="error-banner" role="alert">
          Couldn't load the help pages.{' '}
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </main>
    );
  }
}
