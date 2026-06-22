import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, AlertTriangle, FileX2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { fetchWithAuth } from "@/lib/api";

interface CreditNoteModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: any;
  onEmitted?: () => void;
}

export function CreditNoteModal({ open, onOpenChange, transaction, onEmitted }: CreditNoteModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason("");
      setErrorMsg(null);
      setSubmitting(false);
    }
  }, [open, transaction?.id]);

  const docType = transaction?.invoiceDocType || transaction?.invoiceType || '';
  const voucher = transaction?.invoiceVoucherId || transaction?.invoiceNumber || '';
  const cae = transaction?.invoiceCae || '';
  const isSimulated = !!transaction?.invoiceSimulated;
  const isSandbox = transaction?.invoiceEnvironment === 'sandbox';

  const trimmedReason = reason.trim();
  const canSubmit = trimmedReason.length >= 5 && !submitting && !!transaction?.id;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await fetchWithAuth(`/invoicing/transactions/${transaction.id}/credit-note`, {
        method: 'POST',
        body: JSON.stringify({ reason: trimmedReason }),
      });
      toast({
        title: 'Nota de Crédito emitida',
        description: 'La factura quedó anulada. Encontrarás la NC en Oficina → Facturas.',
      });
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/invoicing/invoices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/accounts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/audit-logs'] });
      if (transaction?.id) {
        queryClient.invalidateQueries({ queryKey: ['transaction', transaction.id] });
      }
      onEmitted?.();
      onOpenChange(false);
    } catch (err: any) {
      const code = err?.code as string | undefined;
      const msg = err?.message || 'No se pudo emitir la Nota de Crédito.';

      // Refresh state regardless — if the NC was actually emitted on the
      // provider's side (BAD_RESPONSE) or by another tab (ALREADY_EMITTED),
      // we want the UI to show the real state.
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/invoicing/invoices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/audit-logs'] });
      if (transaction?.id) {
        queryClient.invalidateQueries({ queryKey: ['transaction', transaction.id] });
      }

      if (code === 'ALREADY_EMITTED') {
        // Soft path: the factura already has an NC. Don't scare the user
        // with a red toast — surface a neutral info toast and close the
        // dialog so they see the updated state.
        toast({
          title: 'La factura ya estaba anulada',
          description: 'Esta factura ya tiene una Nota de Crédito emitida. Actualizamos la vista.',
        });
        onOpenChange(false);
      } else {
        setErrorMsg(msg);
        toast({ title: 'Error al emitir NC', description: msg, variant: 'destructive' });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent
        className="max-w-lg w-[calc(100vw-1.5rem)] max-h-[90vh] overflow-y-auto p-4 sm:p-6"
        data-testid="dialog-credit-note"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileX2 className="h-5 w-5 text-red-600" /> Anular factura con Nota de Crédito
          </DialogTitle>
          <DialogDescription>
            {isSimulated || isSandbox
              ? 'Se emitirá una Nota de Crédito de prueba (sin validez fiscal) que anula esta factura simulada.'
              : 'Se emitirá una Nota de Crédito electrónica que anula esta factura. La operación no se puede deshacer.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-1">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Tipo</span>
              <span className="font-medium" data-testid="text-credit-note-source-type">{docType || '—'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Número</span>
              <span className="font-mono" data-testid="text-credit-note-source-number">{voucher || '—'}</span>
            </div>
            {cae && (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">CAE</span>
                <span className="font-mono text-xs" data-testid="text-credit-note-source-cae">{cae}</span>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 flex gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">
                {isSimulated || isSandbox
                  ? 'Esto generará una NC de prueba — sin validez fiscal.'
                  : 'Esto generará un comprobante fiscal real.'}
              </p>
              <p className="text-amber-800/90">
                Una vez emitida la NC, la factura original quedará marcada como anulada y no podrás reutilizar su número.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="credit-note-reason">Motivo de la anulación</Label>
            <Textarea
              id="credit-note-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 500))}
              placeholder="Ej: Error en el monto, devolución del cliente, factura duplicada…"
              rows={4}
              disabled={submitting}
              data-testid="input-credit-note-reason"
            />
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Mínimo 5 caracteres.</span>
              <span data-testid="text-credit-note-reason-count">{trimmedReason.length}/500</span>
            </div>
          </div>

          {errorMsg && (
            <div
              className="rounded-lg border border-red-200 bg-red-50 text-red-800 p-3 text-sm"
              data-testid="text-credit-note-error"
            >
              {errorMsg}
            </div>
          )}
        </div>

        <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="button-credit-note-cancel"
          >
            Cancelar
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="bg-red-600 hover:bg-red-700 text-white"
            data-testid="button-credit-note-submit"
          >
            {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FileX2 className="h-4 w-4 mr-1" />}
            Anular y emitir NC
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
