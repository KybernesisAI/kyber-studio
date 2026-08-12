import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A renderer exception used to mean a white window and nothing else — no
 * message, no log line, no way to tell a crash from a hang. That is the worst
 * possible failure mode for a desktop app, and it happened here: one panel
 * called `new URL()` on a value that was not an absolute URL.
 *
 * This does not make crashes acceptable. It makes them legible, and recoverable
 * without relaunching.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[renderer] crash", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash__card">
          <div className="crash__title">Something in the interface crashed</div>
          <div className="crash__detail">{error.message}</div>
          <div className="crash__hint">
            Your conversations are saved to disk and will still be here.
          </div>
          <button className="btn btn--primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
