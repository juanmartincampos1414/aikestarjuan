import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ExternalLink, AlertTriangle } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SellingPointSetupGuide({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[85vh] overflow-y-auto"
        data-testid="dialog-selling-point-setup-guide"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Cómo crear un punto de venta compatible con Aikestar
          </DialogTitle>
          <DialogDescription>
            Si no podés emitir facturas, lo más probable es que tu punto de venta en
            ARCA no esté habilitado para facturación electrónica por web service.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-1">
            <p className="font-medium">¿Por qué pasa esto?</p>
            <p className="text-muted-foreground">
              ARCA tiene varios sistemas por punto de venta. El sistema{' '}
              <strong>"Factura en Línea"</strong> sirve solo para cargar facturas a mano
              desde el portal de ARCA y <strong>no permite emisión por web service</strong>.
              Aikestar emite por web service, así que necesitás un punto de venta con
              sistema <strong>"RECE para aplicativo y web services"</strong>.
            </p>
            <p className="text-muted-foreground">
              Por una limitación de ARCA, el alta del nuevo punto de venta solo se puede
              hacer desde el portal oficial. Lo confirmamos con nuestro proveedor de
              facturación: no se puede automatizar desde Aikestar todavía. Son 5 minutos.
            </p>
          </div>

          <div className="space-y-3">
            <p className="font-medium">Pasos para crearlo en ARCA</p>
            <ol className="list-decimal list-outside ml-5 space-y-2 text-muted-foreground">
              <li>
                Entrá a{' '}
                <a
                  href="https://auth.afip.gob.ar"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-600 dark:text-cyan-400 underline underline-offset-2 inline-flex items-center gap-1"
                  data-testid="link-guide-arca-login"
                >
                  auth.afip.gob.ar
                  <ExternalLink className="h-3 w-3" />
                </a>{' '}
                con tu CUIT y clave fiscal.
              </li>
              <li>
                En el buscador de servicios, buscá{' '}
                <strong>"Administración de Puntos de Venta y Domicilios"</strong> y entrá.
              </li>
              <li>
                Elegí la empresa (tu CUIT) y entrá a <strong>"A/B/M de Puntos de venta"</strong>.
              </li>
              <li>
                Tocá el botón <strong>"+"</strong> (icono rojo, arriba a la derecha).
              </li>
              <li>
                Completá el formulario:
                <ul className="list-disc list-outside ml-5 mt-1 space-y-1">
                  <li>
                    <strong>Número de punto de venta</strong>: el siguiente disponible
                    (probablemente el 2).
                  </li>
                  <li>
                    <strong>Nombre de fantasía</strong>: el que quieras.
                  </li>
                  <li>
                    <strong>Sistema</strong>: elegí{' '}
                    <strong>"RECE para aplicativo y web services"</strong>. No elijas
                    "Factura en Línea" — es el que tenés hoy y no funciona.
                  </li>
                  <li>
                    <strong>Domicilio</strong>: tu domicilio fiscal.
                  </li>
                </ul>
              </li>
              <li>Guardá los cambios.</li>
              <li>
                Volvé a Aikestar a esta misma pantalla y tocá{' '}
                <strong>"Reiniciar punto de venta"</strong> (o el botón de refrescar)
                para que Aikestar lea el nuevo punto de venta.
              </li>
              <li>
                En el selector, elegí el punto de venta nuevo como predeterminado.
              </li>
              <li>Probá emitir una factura. Esta vez sí va a salir.</li>
            </ol>
          </div>

          <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            ¿Trabás en algún paso? Escribinos por soporte con una captura del portal de
            ARCA y te ayudamos a terminar el alta.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
