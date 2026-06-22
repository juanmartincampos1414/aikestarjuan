import { useEffect, useState } from 'react';
import { useSearch, useLocation } from 'wouter';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle, XCircle, PartyPopper } from 'lucide-react';
import aikestarLogo from '@/assets/aikestar-logo.png';

type Status = 'loading' | 'success' | 'error';
type FlowType = 'signup' | 'plan-change' | 'subscription';

export default function PaymentSuccessPage() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string>('');
  const [retryCount, setRetryCount] = useState(0);
  const [flowType, setFlowType] = useState<FlowType>('subscription');
  const [planName, setPlanName] = useState<string>('');

  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const sessionId = params.get('session_id');
    const plan = params.get('plan');
    const changed = params.get('changed');

    if (plan) setPlanName(plan);

    if (sessionId) {
      setFlowType('signup');
      validateSignup(sessionId);
    } else if (changed === 'true') {
      setFlowType('plan-change');
      setStatus('success');
      redirectAfterDelay('/settings?tab=plan');
    } else {
      setFlowType('subscription');
      setStatus('success');
      redirectAfterDelay('/settings?tab=plan');
    }
  }, [searchString, retryCount]);

  function redirectAfterDelay(path: string) {
    setTimeout(() => {
      window.location.replace(path);
    }, 3000);
  }

  async function validateSignup(sessionId: string) {
    try {
      let csrfToken = '';
      try {
        const csrfResponse = await fetch('/api/csrf-token', { credentials: 'include' });
        if (csrfResponse.ok) {
          const csrfData = await csrfResponse.json();
          csrfToken = csrfData?.csrfToken || '';
        }
      } catch {
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

      try {
        localStorage.setItem('aikestar_checkout_session', sessionId);
        localStorage.setItem('aikestar_checkout_time', Date.now().toString());
      } catch {
      }

      redirectAfterDelay('/');
    } catch (err: any) {
      setStatus('error');
      setError(err.message || 'Error al validar el pago');
    }
  }

  const successTitle = flowType === 'signup'
    ? '¡Cuenta creada exitosamente!'
    : flowType === 'plan-change'
      ? '¡Plan actualizado!'
      : '¡Suscripción activada!';

  const successSubtitle = flowType === 'signup'
    ? 'Tu cuenta está lista. Redirigiendo al dashboard...'
    : 'Redirigiendo a tu cuenta...';

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
          <img src={aikestarLogo} alt="Aikestar" className="h-12 mx-auto" data-testid="img-logo" />

          {status === 'loading' && (
            <>
              <div className="flex justify-center">
                <Loader2 className="h-16 w-16 text-[#00D4FF] animate-spin" data-testid="icon-loading" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white mb-2" data-testid="text-loading-title">
                  {flowType === 'signup' ? 'Creando tu cuenta...' : 'Procesando tu pago...'}
                </h2>
                <p className="text-slate-400" data-testid="text-loading-subtitle">
                  Estamos procesando tu pago y configurando todo para vos.
                </p>
              </div>
            </>
          )}

          {status === 'success' && (
            <>
              <div className="flex justify-center">
                <div className="relative">
                  <CheckCircle className="h-16 w-16 text-emerald-500" data-testid="icon-success" />
                  <PartyPopper className="h-6 w-6 text-yellow-400 absolute -top-1 -right-1 animate-bounce" />
                </div>
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white mb-2" data-testid="text-success-title">
                  {successTitle}
                </h2>
                {planName && (
                  <p className="text-[#00D4FF] font-medium mb-2" data-testid="text-plan-name">
                    Plan {planName.charAt(0).toUpperCase() + planName.slice(1)}
                  </p>
                )}
                <p className="text-slate-400" data-testid="text-success-subtitle">
                  {successSubtitle}
                </p>
              </div>
            </>
          )}

          {status === 'error' && (
            <>
              <div className="flex justify-center">
                <XCircle className="h-16 w-16 text-red-500" data-testid="icon-error" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white mb-2" data-testid="text-error-title">
                  Hubo un problema
                </h2>
                <p className="text-slate-400 mb-4" data-testid="text-error-message">
                  {error}
                </p>
                <Button
                  onClick={() => setLocation('/login')}
                  className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366] hover:opacity-90"
                  data-testid="button-back-to-auth"
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
