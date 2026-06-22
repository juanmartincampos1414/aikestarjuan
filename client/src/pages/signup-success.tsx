import { useEffect, useState } from 'react';
import { useSearch, useLocation } from 'wouter';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';
import aikestarLogo from '@/assets/aikestar-logo.png';

type Status = 'loading' | 'success' | 'error';

export default function SignupSuccessPage() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string>('');
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const validateCheckout = async () => {
      const params = new URLSearchParams(searchString);
      const sessionId = params.get('session_id');

      if (!sessionId) {
        setStatus('error');
        setError('No se encontró la sesión de pago');
        return;
      }

      try {
        // Try to get CSRF token, but don't fail if unavailable
        // (session may not exist yet when returning from Stripe)
        let csrfToken = '';
        try {
          const csrfResponse = await fetch('/api/csrf-token', { credentials: 'include' });
          if (csrfResponse.ok) {
            const csrfData = await csrfResponse.json();
            csrfToken = csrfData?.csrfToken || '';
          }
        } catch {
          // Ignore CSRF errors - endpoint is exempted anyway
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (csrfToken) {
          headers['x-csrf-token'] = csrfToken;
        }

        const response = await fetch('/api/auth/validate-checkout', {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify({ sessionId }),
        });

        const result = await response.json().catch(() => ({ message: 'Error de conexión. Por favor intentá de nuevo.' }));

        if (!response.ok) {
          if (result.message?.includes('siendo creada') && retryCount < 3) {
            setTimeout(() => setRetryCount(r => r + 1), 2000);
            return;
          }
          throw new Error(result.message || 'Error al validar el pago');
        }

        setStatus('success');
        
        // Save session info for mobile browsers that may lose cookies after redirect
        try {
          localStorage.setItem('aikestar_checkout_session', sessionId);
          localStorage.setItem('aikestar_checkout_time', Date.now().toString());
        } catch {
        }
        
        // Force a small delay to ensure cookies are properly saved on mobile browsers
        // Then use replace() instead of href to avoid back-button issues
        setTimeout(() => {
          window.location.replace('/');
        }, 2500);
      } catch (err: any) {
        setStatus('error');
        setError(err.message || 'Error al validar el pago');
      }
    };

    validateCheckout();
  }, [searchString, retryCount]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{
      background: 'linear-gradient(135deg, #0a0a1a 0%, #1a1a3a 50%, #0a0a1a 100%)',
    }}>
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-[#00D4FF]/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-[#FF3366]/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <Card className="w-full max-w-md relative z-10 bg-slate-900/90 border-slate-700/50 backdrop-blur-xl shadow-2xl">
        <CardContent className="p-8 text-center space-y-6">
          <img src={aikestarLogo} alt="Aikestar" className="h-12 mx-auto" />
          
          {status === 'loading' && (
            <>
              <div className="flex justify-center">
                <Loader2 className="h-16 w-16 text-[#00D4FF] animate-spin" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white mb-2">
                  Creando tu cuenta...
                </h2>
                <p className="text-slate-400">
                  Estamos procesando tu pago y configurando todo para vos.
                </p>
              </div>
            </>
          )}

          {status === 'success' && (
            <>
              <div className="flex justify-center">
                <CheckCircle className="h-16 w-16 text-emerald-500" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white mb-2">
                  ¡Cuenta creada exitosamente!
                </h2>
                <p className="text-slate-400">
                  Redirigiendo al dashboard...
                </p>
              </div>
            </>
          )}

          {status === 'error' && (
            <>
              <div className="flex justify-center">
                <XCircle className="h-16 w-16 text-red-500" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white mb-2">
                  Hubo un problema
                </h2>
                <p className="text-slate-400 mb-4">
                  {error}
                </p>
                <Button
                  onClick={() => setLocation('/login')}
                  className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366] hover:opacity-90"
                >
                  Volver al inicio
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
