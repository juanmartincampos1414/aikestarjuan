import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { paymentMethodAPI } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { Plus, Pencil, Trash2, CreditCard, ShieldAlert, RotateCcw } from 'lucide-react';
import type { PaymentMethodWithConcepts } from '@shared/schema';
import PaymentMethodEditorDialog from '@/components/PaymentMethodEditorDialog';

interface PaymentMethodsSectionProps {
  canEdit: boolean;
}

export default function PaymentMethodsSection({ canEdit }: PaymentMethodsSectionProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<PaymentMethodWithConcepts | null>(null);
  const [deleteCandidate, setDeleteCandidate] = React.useState<PaymentMethodWithConcepts | null>(null);

  const { data: methods = [], isLoading } = useQuery<PaymentMethodWithConcepts[]>({
    queryKey: ['/api/payment-methods'],
    queryFn: () => paymentMethodAPI.getAll(),
  });

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (m: PaymentMethodWithConcepts) => {
    setEditing(m);
    setDialogOpen(true);
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => paymentMethodAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/payment-methods'] });
      toast({ title: 'Medio desactivado', description: 'Los movimientos históricos se conservan' });
      setDeleteCandidate(null);
    },
    onError: (err: any) => {
      toast({ title: 'Error', description: err?.message || 'No se pudo desactivar', variant: 'destructive' });
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => paymentMethodAPI.update(id, { isActive: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/payment-methods'] });
      toast({ title: 'Medio reactivado' });
    },
    onError: (err: any) => {
      toast({ title: 'Error', description: err?.message || 'No se pudo reactivar', variant: 'destructive' });
    },
  });

  const activeMethods = methods.filter((m) => m.isActive);
  const inactiveMethods = methods.filter((m) => !m.isActive);

  if (!canEdit) {
    return (
      <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/50 border" data-testid="payment-methods-no-permission">
        <ShieldAlert className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
        <div className="text-sm text-muted-foreground">
          Solo los administradores y dueños pueden gestionar medios de cobro.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="text-sm text-muted-foreground max-w-2xl">
          Definí medios de cobro (ej: "MercadoPago 6 cuotas") con sus conceptos asociados (comisiones,
          impuestos, costos fijos). Cuando registres una venta o un por cobrar con ese medio, se
          generan automáticamente los costos vinculados.
        </div>
        <Button onClick={openNew} data-testid="button-new-payment-method" className="shrink-0">
          <Plus className="h-4 w-4 mr-2" /> Nuevo medio
        </Button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Cargando…</div>
      ) : activeMethods.length === 0 && inactiveMethods.length === 0 ? (
        <div className="border rounded-lg p-8 text-center" data-testid="empty-payment-methods">
          <CreditCard className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
          <p className="font-medium">Todavía no creaste ningún medio de cobro</p>
          <p className="text-sm text-muted-foreground mt-1">
            Empezá creando uno (por ejemplo "MercadoPago 6 cuotas" o "Transferencia").
          </p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead className="hidden md:table-cell">Conceptos</TableHead>
                <TableHead className="w-24">Estado</TableHead>
                <TableHead className="w-32 text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...activeMethods, ...inactiveMethods].map((m) => (
                <TableRow key={m.id} data-testid={`row-payment-method-${m.id}`}>
                  <TableCell>
                    <div className="font-medium" data-testid={`text-method-name-${m.id}`}>{m.name}</div>
                    {m.description && (
                      <div className="text-xs text-muted-foreground mt-0.5 max-w-md truncate">{m.description}</div>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    {m.concepts.length === 0 ? (
                      <span className="italic">Sin conceptos</span>
                    ) : (
                      <span>{m.concepts.length} concepto{m.concepts.length === 1 ? '' : 's'}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {m.isActive ? (
                      <Badge variant="outline" className="bg-green-500/10 text-green-700 border-green-500/30">Activo</Badge>
                    ) : (
                      <Badge variant="outline" className="bg-muted text-muted-foreground">Inactivo</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center gap-1 justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(m)}
                        data-testid={`button-edit-method-${m.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {m.isActive ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteCandidate(m)}
                          data-testid={`button-deactivate-method-${m.id}`}
                          title="Desactivar"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => reactivateMutation.mutate(m.id)}
                          disabled={reactivateMutation.isPending}
                          data-testid={`button-reactivate-method-${m.id}`}
                          title="Reactivar"
                        >
                          <RotateCcw className="h-4 w-4 text-emerald-600" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <PaymentMethodEditorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialMethod={editing}
      />

      <AlertDialog open={!!deleteCandidate} onOpenChange={(open) => !open && setDeleteCandidate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desactivar "{deleteCandidate?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              El medio dejará de estar disponible para nuevas ventas, pero los movimientos existentes
              que ya lo tengan asignado se conservan tal cual. Podés reactivarlo más tarde.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-deactivate-method">Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteCandidate && deleteMutation.mutate(deleteCandidate.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-deactivate-method"
            >
              {deleteMutation.isPending ? 'Desactivando…' : 'Desactivar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
