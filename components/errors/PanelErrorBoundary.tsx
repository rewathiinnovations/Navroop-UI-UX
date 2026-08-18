'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import ErrorId from './ErrorId';

type Props = { children: ReactNode; label: string };
type State = { requestId: string | null };

export default class PanelErrorBoundary extends Component<Props, State> {
  state: State = { requestId: null };

  static getDerivedStateFromError() {
    return { requestId: crypto.randomUUID().replace(/-/g, '').slice(0, 12) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'ui.panel.crash',
      requestId: this.state.requestId,
      label: this.props.label,
      error: error.message,
      componentStack: process.env.NODE_ENV === 'production' ? undefined : info.componentStack,
    }));
  }

  render() {
    if (this.state.requestId) {
      return (
        <div className="flex h-full min-h-[160px] items-center justify-center p-20">
          <ErrorId
            requestId={this.state.requestId}
            message={`${this.props.label} crashed. The rest of the workspace is still running.`}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
