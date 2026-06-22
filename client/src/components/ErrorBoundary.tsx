import React from 'react';
import { MessageCircle } from 'lucide-react';

const WHATSAPP_NUMBER = "5491153874843";

function buildWhatsAppUrl(errorMessage?: string) {
  const text = errorMessage
    ? `Hola, la app Aikestar se rompió con este error: "${errorMessage}"`
    : "Hola, la app Aikestar se rompió y me apareció la pantalla de error. Necesito ayuda.";
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, errorMessage: error?.message || null };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-6">
          <div className="text-center max-w-md space-y-4">
            <h1 className="text-2xl font-bold text-foreground">Algo salió mal</h1>
            <p className="text-muted-foreground">
              Ocurrió un error inesperado. Intentá recargar la página.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
                data-testid="button-reload"
              >
                Recargar
              </button>
              <a
                href={buildWhatsAppUrl(this.state.errorMessage || undefined)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2 bg-[#25D366] text-white rounded-md hover:bg-[#1da851] transition-colors font-medium text-sm"
                data-testid="link-whatsapp-crash"
              >
                <MessageCircle className="h-4 w-4" />
                Avisanos
              </a>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
