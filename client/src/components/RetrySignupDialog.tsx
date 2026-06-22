import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, AlertTriangle, CheckCircle2, Sparkles } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Llamar a la guía manual de creación de PV cuando el reintento no logra crear uno nuevo. */
  onFallbackToManual: () => void;
}

type RetryResult = {
  success: boolean;
  previousDefault: number | null;
  newDefault: number | null;
  recreated: boolean;
  sellingPoints: { number: number; isActive: boolean }[];
};

export function RetrySignupDialog({ open, onOpenChange, onFallbackToManual }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [claveFiscal, setClaveFiscal] = useState('');
  const [result, setResult] = useState<RetryResult | null>(null);

  const retry = useMutation<RetryResult, Error, void>({
    mutationFn: async () => {
      return fetchWithAuth('/invoicing/signup/retry', {
        method: 'POST',
        body: JSON.stringify({ claveFiscal }),
      });
    },
    onSuccess: (res) => {
      setResult(res);
      queryClient.invalidateQueries({ queryKey: ['/api/invoicing/account'] });
      if (res.recreated) {
        toast({
          title: '¡Punto de venta nuevo creado!',
          description: `Tu nuevo PV en ARCA es el número ${res.newDefault}. Ya podés emitir facturas.`,
        });
      }
    },
    onError: (e) => {
      toast({
        title: 'No pudimos reintentar el alta',
        description: e.message,
        variant: 'destructive',
      });
    },
  });

  const handleClose = (next: boolean) => {
    if (!next) {
      setClaveFiscal('');
      setResult(null);
      retry.reset();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-lg"
        data-testid="dialog-retry-signup"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-cyan-500" />
            Reintentar alta automática en ARCA
          </DialogTitle>
          <DialogDescription>
            Le pedimos a ARCA, a través de nuestro proveedor, que cree un punto de
            venta nuevo compatible con emisión electrónica. Suele tardar pocos segundos.
          </DialogDescription>
        </DialogHeader>

        {!result ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-cyan-500/40 bg-cyan-500/5 p-3 text-sm space-y-1">
              <p>
                <strong>¿Qué pasa al confirmar?</strong>
              </p>
              <ul className="list-disc list-outside ml-5 text-muted-foreground space-y-1">
                <li>Validamos tu clave fiscal contra ARCA.</li>
                <li>
                  Le pedimos a ARCA que cree un punto de venta nuevo con sistema{' '}
                  <strong>"RECE / Web Services"</strong>.
                </li>
                <li>Actualizamos tu configuración con el PV nuevo.</li>
              </ul>
              <p className="text-xs text-muted-foreground pt-1">
                Tu clave fiscal no se guarda en Aikestar: solo se usa para esta
                operación contra ARCA.
              </p>
            </div>

            <div>
              <Label htmlFor="retry-clave-fiscal">Clave fiscal de ARCA</Label>
              <Input
                id="retry-clave-fiscal"
                data-testid="input-retry-clave-fiscal"
                type="password"
                value={claveFiscal}
                onChange={(e) => setClaveFiscal(e.target.value.slice(0, 100))}
                placeholder="La que usás para entrar a auth.afip.gob.ar"
                autoComplete="off"
                disabled={retry.isPending}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Es la misma clave fiscal con la que ingresás al portal de ARCA.
              </p>
            </div>
          </div>
        ) : result.recreated ? (
          <Alert
            data-testid="alert-retry-success"
            className="border-emerald-500/50 bg-emerald-500/5"
          >
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <AlertDescription className="space-y-2">
              <p>
                <strong>¡Listo!</strong> ARCA creó un punto de venta nuevo compatible
                con emisión electrónica.
              </p>
              <p className="text-sm">
                Nuevo punto de venta: <strong>PV {result.newDefault}</strong>. Ya quedó
                configurado como tu PV por defecto.
              </p>
              <p className="text-xs text-muted-foreground">
                Probá emitir una factura — esta vez sí va a salir.
              </p>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert
            data-testid="alert-retry-fallback"
            className="border-amber-500/50 bg-amber-500/5"
          >
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <AlertDescription className="space-y-2">
              <p>
                <strong>El alta automática no creó un punto de venta nuevo.</strong>{' '}
                ARCA devolvió el mismo PV que ya tenías
                {result.newDefault != null ? ` (PV ${result.newDefault})` : ''}.
              </p>
              <p className="text-sm text-muted-foreground">
                Esto puede pasar si tu CUIT ya tenía registrado un PV de tipo "Factura
                en Línea" y ARCA prefiere reutilizarlo. La buena noticia: crear uno
                nuevo manualmente en el portal son 5 minutos. Te dejamos los pasos.
              </p>
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter className="gap-2">
          {!result ? (
            <>
              <Button
                variant="ghost"
                onClick={() => handleClose(false)}
                disabled={retry.isPending}
                data-testid="button-retry-cancel"
              >
                Cancelar
              </Button>
              <Button
                onClick={() => retry.mutate()}
                disabled={!claveFiscal || retry.isPending}
                data-testid="button-retry-confirm"
                className="bg-gradient-to-r from-pink-500 to-cyan-500 hover:opacity-90 text-white"
              >
                {retry.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Reintentando…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" />
                    Reintentar alta
                  </>
                )}
              </Button>
            </>
          ) : result.recreated ? (
            <Button
              onClick={() => handleClose(false)}
              data-testid="button-retry-done"
            >
              Listo
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => handleClose(false)}
                data-testid="button-retry-close"
              >
                Cerrar
              </Button>
              <Button
                onClick={() => {
                  handleClose(false);
                  onFallbackToManual();
                }}
                data-testid="button-retry-open-manual-guide"
              >
                Ver pasos para crearlo manualmente
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
