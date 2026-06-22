import React from 'react';
import { useToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import type { ToastActionElement } from '@/components/ui/toast';
import { undoAPI } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { pushGlobalUndoAction, removeGlobalUndoAction } from '@/components/UndoButton';

const ENTITY_LABELS: Record<string, string> = {
  account: 'Cuenta',
  transaction: 'Movimiento',
  client: 'Cliente',
  supplier: 'Proveedor',
  product: 'Producto',
  transaction_created: 'Movimiento creado',
  transfer_created: 'Transferencia creada',
};

const ENTITY_QUERY_KEYS: Record<string, string[][]> = {
  account: [['accounts']],
  transaction: [['transactions'], ['transaction'], ['transactions', 'completed'], ['transactions', 'scheduled'], ['/api/transactions'], ['accounts'], ['/api/audit-logs'], ['calendar'], ['/api/notifications'], ['/api/pending-commitments']],
  client: [['/api/clients']],
  supplier: [['/api/suppliers']],
  product: [['/api/products']],
  transaction_created: [['transactions'], ['transaction'], ['transactions', 'completed'], ['transactions', 'scheduled'], ['/api/transactions'], ['accounts'], ['/api/audit-logs'], ['calendar']],
  transfer_created: [['transactions'], ['transaction'], ['transactions', 'completed'], ['transactions', 'scheduled'], ['/api/transactions'], ['accounts'], ['/api/audit-logs'], ['calendar']],
};

const UNDO_WINDOW_MS = 60000;

export function useUndoDelete() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const showUndoToast = (undoKey: string, entityType: string, entityName?: string) => {
    const label = ENTITY_LABELS[entityType] || entityType;
    const displayName = entityName ? `"${entityName}"` : '';

    pushGlobalUndoAction({
      undoKey,
      entityType,
      entityName,
      expiresAt: Date.now() + UNDO_WINDOW_MS,
    });

    toast({
      title: `${label} eliminado/a`,
      description: displayName ? `${displayName} fue eliminado/a.` : `El/la ${label.toLowerCase()} fue eliminado/a.`,
      duration: 8000,
      action: React.createElement(
        ToastAction,
        {
          altText: 'Deshacer eliminación',
          onClick: async () => {
            try {
              await undoAPI.restore(undoKey);
              const queryKeys = ENTITY_QUERY_KEYS[entityType] || [];
              queryKeys.forEach(key => queryClient.invalidateQueries({ queryKey: key }));
              removeGlobalUndoAction(undoKey);
              toast({
                title: 'Acción deshecha correctamente',
                description: `${label} ${displayName} fue restaurado/a correctamente.`,
                duration: 6000,
              });
            } catch {
              removeGlobalUndoAction(undoKey);
              toast({
                title: 'No se pudo deshacer la acción',
                description: 'El tiempo para deshacer esta acción expiró.',
                variant: 'destructive',
                duration: 3000,
              });
            }
          },
        },
        'Deshacer'
      ) as unknown as ToastActionElement,
    });
  };

  return { showUndoToast };
}
