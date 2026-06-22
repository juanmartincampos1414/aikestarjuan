import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { profitabilityCodeAPI } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { Plus, Pencil, Trash2, Tags, ShieldAlert, RotateCcw } from 'lucide-react';
import type { ProfitabilityCode } from '@shared/schema';

const codeFormSchema = z.object({
  code: z.string().trim().min(1, 'El código es requerido').max(20, 'Máximo 20 caracteres'),
  name: z.string().trim().min(2, 'El nombre es requerido').max(100, 'Máximo 100 caracteres'),
  description: z.string().trim().max(500, 'Máximo 500 caracteres').optional().or(z.literal('')),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color inválido (ej: #06b6d4)').optional().or(z.literal('')),
});

type CodeFormValues = z.infer<typeof codeFormSchema>;

const PRESET_COLORS = ['#06b6d4', '#ec4899', '#22c55e', '#f59e0b', '#a855f7', '#3b82f6', '#ef4444', '#14b8a6'];

interface ProfitabilityCodesSectionProps {
  canEdit: boolean;
}

export default function ProfitabilityCodesSection({ canEdit }: ProfitabilityCodesSectionProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ProfitabilityCode | null>(null);
  const [deleteCandidate, setDeleteCandidate] = React.useState<ProfitabilityCode | null>(null);

  // Task #363: incluir archivados para mostrar pestaña restaurable
  const { data: codes = [], isLoading } = useQuery<ProfitabilityCode[]>({
    queryKey: ['/api/profitability-codes', 'with-archived'],
    queryFn: () => profitabilityCodeAPI.getAll(false, { includeArchived: true }),
  });

  const [forceDelete, setForceDelete] = React.useState(false);

  const form = useForm<CodeFormValues>({
    resolver: zodResolver(codeFormSchema),
    defaultValues: { code: '', name: '', description: '', color: '' },
  });

  const openNew = () => {
    setEditing(null);
    form.reset({ code: '', name: '', description: '', color: '' });
    setDialogOpen(true);
  };

  const openEdit = (code: ProfitabilityCode) => {
    setEditing(code);
    form.reset({
      code: code.code,
      name: code.name,
      description: code.description || '',
      color: code.color || '',
    });
    setDialogOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: async (values: CodeFormValues) => {
      const payload = {
        code: values.code,
        name: values.name,
        description: values.description || null,
        color: values.color || null,
      };
      if (editing) {
        return profitabilityCodeAPI.update(editing.id, payload);
      }
      return profitabilityCodeAPI.create(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/profitability-codes'] });
      toast({ title: editing ? 'Código actualizado' : 'Código creado' });
      setDialogOpen(false);
    },
    onError: (err: any) => {
      toast({ title: 'Error', description: err?.message || 'No se pudo guardar el código', variant: 'destructive' });
    },
  });

  // Task #363: DELETE unificado — borra si no tiene historia, archiva si la tiene.
  const deleteMutation = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) => profitabilityCodeAPI.delete(id, { force }),
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/profitability-codes'] });
      if (result?.archived) {
        toast({ title: 'Código archivado', description: 'Tenía movimientos o productos asociados, así que se conservó como archivado.' });
      } else {
        toast({ title: 'Código eliminado' });
      }
      setDeleteCandidate(null);
      setForceDelete(false);
    },
    onError: (err: any) => {
      toast({ title: 'Error', description: err?.message || 'No se pudo eliminar', variant: 'destructive' });
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: (id: string) => profitabilityCodeAPI.unarchive(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/profitability-codes'] });
      toast({ title: 'Código restaurado', description: 'Ya podés volver a usarlo en movimientos y productos' });
    },
    onError: (err: any) => {
      toast({ title: 'Error', description: err?.message || 'No se pudo restaurar', variant: 'destructive' });
    },
  });

  const onSubmit = (values: CodeFormValues) => saveMutation.mutate(values);

  // Task #363: usamos archivedAt como source of truth, isActive queda sincronizado
  const activeCodes = codes.filter((c) => !c.archivedAt);
  const inactiveCodes = codes.filter((c) => !!c.archivedAt);

  if (!canEdit) {
    return (
      <div className="flex items-start gap-3 p-4 rounded-lg bg-muted/50 border" data-testid="profitability-codes-no-permission">
        <ShieldAlert className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
        <div className="text-sm text-muted-foreground">
          Solo los administradores y dueños pueden gestionar códigos de análisis de rentabilidad.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="text-sm text-muted-foreground max-w-2xl">
          Etiquetá movimientos (ingresos, egresos, por cobrar y por pagar) y productos con un código transversal
          para luego ver la rentabilidad agrupada en Reportes. Los códigos son independientes de clientes y proyectos.
        </div>
        <Button onClick={openNew} data-testid="button-new-profitability-code" className="shrink-0">
          <Plus className="h-4 w-4 mr-2" /> Nuevo código
        </Button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Cargando…</div>
      ) : activeCodes.length === 0 && inactiveCodes.length === 0 ? (
        <div className="border rounded-lg p-8 text-center" data-testid="empty-profitability-codes">
          <Tags className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
          <p className="font-medium">Todavía no creaste ningún código</p>
          <p className="text-sm text-muted-foreground mt-1">
            Empezá creando un código (por ejemplo "OBRA-01" o "PROD-PREMIUM").
          </p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Código</TableHead>
                <TableHead>Nombre</TableHead>
                <TableHead className="hidden md:table-cell">Descripción</TableHead>
                <TableHead className="w-24">Estado</TableHead>
                <TableHead className="w-32 text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...activeCodes, ...inactiveCodes].map((code) => (
                <TableRow key={code.id} data-testid={`row-profitability-code-${code.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {code.color && (
                        <span
                          className="inline-block w-3 h-3 rounded-full border"
                          style={{ backgroundColor: code.color }}
                        />
                      )}
                      <span className="font-mono font-semibold" data-testid={`text-code-${code.id}`}>{code.code}</span>
                    </div>
                  </TableCell>
                  <TableCell data-testid={`text-name-${code.id}`}>{code.name}</TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground max-w-md truncate">
                    {code.description || '—'}
                  </TableCell>
                  <TableCell>
                    {!code.archivedAt ? (
                      <Badge variant="outline" className="bg-green-500/10 text-green-700 border-green-500/30">Activo</Badge>
                    ) : (
                      <Badge variant="outline" className="bg-muted text-muted-foreground">Archivado</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center gap-1 justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(code)}
                        data-testid={`button-edit-code-${code.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {!code.archivedAt ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteCandidate(code)}
                          data-testid={`button-delete-code-${code.id}`}
                          title="Eliminar"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => unarchiveMutation.mutate(code.id)}
                          disabled={unarchiveMutation.isPending}
                          data-testid={`button-restore-code-${code.id}`}
                          title="Restaurar"
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{editing ? 'Editar código' : 'Nuevo código de rentabilidad'}</DialogTitle>
            <DialogDescription>
              Los códigos sirven para etiquetar movimientos y productos para análisis cruzados en Reportes.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Código *</FormLabel>
                    <FormControl>
                      <Input placeholder="OBRA-01" {...field} data-testid="input-profitability-code-code" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nombre *</FormLabel>
                    <FormControl>
                      <Input placeholder="Obra principal Edificio Belgrano" {...field} data-testid="input-profitability-code-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Descripción</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Notas internas (opcional)" {...field} data-testid="input-profitability-code-description" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="color"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Color (opcional)</FormLabel>
                    <FormControl>
                      <div className="flex items-center gap-2 flex-wrap">
                        {PRESET_COLORS.map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => field.onChange(c)}
                            className={`w-7 h-7 rounded-full border-2 transition-transform ${field.value === c ? 'border-foreground scale-110' : 'border-transparent'}`}
                            style={{ backgroundColor: c }}
                            data-testid={`button-color-${c}`}
                            aria-label={`Color ${c}`}
                          />
                        ))}
                        <Input
                          placeholder="#06b6d4"
                          value={field.value || ''}
                          onChange={(e) => field.onChange(e.target.value)}
                          className="w-32 font-mono text-sm"
                          data-testid="input-profitability-code-color"
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} data-testid="button-cancel-code">
                  Cancelar
                </Button>
                <Button type="submit" disabled={saveMutation.isPending} data-testid="button-save-code">
                  {saveMutation.isPending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear código'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteCandidate}
        onOpenChange={(open) => { if (!open) { setDeleteCandidate(null); setForceDelete(false); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar "{deleteCandidate?.code}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Si el código no fue usado por movimientos ni productos, se elimina. Si tiene historia, en vez de
              borrarlo se archiva para preservar tus reportes. Podés restaurarlo desde la lista.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {canEdit && (
            <label className="flex items-start gap-2 text-sm rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <input
                type="checkbox"
                checked={forceDelete}
                onChange={(e) => setForceDelete(e.target.checked)}
                className="mt-0.5"
                data-testid="checkbox-force-delete-code"
              />
              <span>
                <span className="font-medium text-destructive">Eliminar definitivamente</span>
                <span className="block text-muted-foreground text-xs mt-0.5">
                  No se podrá deshacer. Falla si el código está usado por movimientos o productos.
                </span>
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-code">Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteCandidate && deleteMutation.mutate({ id: deleteCandidate.id, force: forceDelete })}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete-code"
            >
              {deleteMutation.isPending ? 'Eliminando…' : forceDelete ? 'Eliminar definitivamente' : 'Eliminar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
