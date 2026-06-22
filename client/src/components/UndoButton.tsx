import { useState, useEffect, useCallback } from 'react';
import { Undo2, Clock, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { undoAPI } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';

export interface UndoAction {
  undoKey: string;
  entityType: string;
  entityName?: string;
  expiresAt: number;
}

const MAX_UNDO_STACK = 3;

const ENTITY_LABELS: Record<string, string> = {
  account: 'Cuenta',
  transaction: 'Movimiento',
  client: 'Cliente',
  supplier: 'Proveedor',
  product: 'Producto',
  transaction_created: 'Movimiento creado',
  transfer_created: 'Transferencia creada',
  transaction_approved: 'Movimiento aprobado',
};

const ENTITY_QUERY_KEYS: Record<string, string[][]> = {
  account: [['accounts']],
  transaction: [['transactions'], ['transaction'], ['transactions', 'completed'], ['transactions', 'scheduled'], ['/api/transactions'], ['accounts'], ['/api/audit-logs'], ['calendar'], ['/api/notifications'], ['/api/pending-commitments']],
  client: [['/api/clients']],
  supplier: [['/api/suppliers']],
  product: [['/api/products']],
  transaction_created: [['transactions'], ['transaction'], ['transactions', 'completed'], ['transactions', 'scheduled'], ['/api/transactions'], ['accounts'], ['/api/audit-logs'], ['calendar'], ['/api/notifications'], ['/api/pending-commitments']],
  transfer_created: [['transactions'], ['transaction'], ['transactions', 'completed'], ['transactions', 'scheduled'], ['/api/transactions'], ['accounts'], ['/api/audit-logs'], ['calendar'], ['/api/notifications'], ['/api/pending-commitments']],
  transaction_approved: [['transactions'], ['transaction'], ['transactions', 'completed'], ['transactions', 'scheduled'], ['/api/transactions'], ['accounts'], ['/api/pending-commitments'], ['/api/notifications'], ['/api/audit-logs']],
};

let undoStack: UndoAction[] = [];
let listeners: Array<() => void> = [];

function notifyListeners() {
  listeners.forEach(fn => fn());
}

function pruneExpired() {
  const now = Date.now();
  const before = undoStack.length;
  undoStack = undoStack.filter(a => a.expiresAt > now);
  if (undoStack.length !== before) notifyListeners();
}

export function pushGlobalUndoAction(action: UndoAction) {
  pruneExpired();
  undoStack = [action, ...undoStack].slice(0, MAX_UNDO_STACK);
  notifyListeners();
}

export function removeGlobalUndoAction(undoKey: string) {
  undoStack = undoStack.filter(a => a.undoKey !== undoKey);
  notifyListeners();
}

export function clearGlobalUndoAction() {
  undoStack = [];
  notifyListeners();
}

export const setGlobalUndoAction = pushGlobalUndoAction;

function useGlobalUndoStack() {
  const [stack, setStack] = useState<UndoAction[]>(undoStack);

  useEffect(() => {
    const listener = () => setStack([...undoStack]);
    listeners.push(listener);
    return () => {
      listeners = listeners.filter(l => l !== listener);
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(pruneExpired, 1000);
    return () => clearInterval(interval);
  }, []);

  return stack;
}

function timeAgo(expiresAt: number): string {
  const elapsed = Math.max(0, 60 - Math.round((expiresAt - Date.now()) / 1000));
  return `hace ${elapsed}s`;
}

export function UndoButton() {
  const stack = useGlobalUndoStack();
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!open || stack.length === 0) return;
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [open, stack.length]);

  const handleRestore = useCallback(async (action: UndoAction) => {
    setRestoringKey(action.undoKey);
    try {
      await undoAPI.restore(action.undoKey);
      const queryKeys = ENTITY_QUERY_KEYS[action.entityType] || [];
      queryKeys.forEach(key => queryClient.invalidateQueries({ queryKey: key }));
      const label = ENTITY_LABELS[action.entityType] || action.entityType;
      const displayName = action.entityName ? `"${action.entityName}"` : '';
      const isUndoCreate = action.entityType === 'transaction_created' || action.entityType === 'transfer_created';
      const isUndoApproval = action.entityType === 'transaction_approved';
      toast({
        title: 'Acción deshecha correctamente',
        description: isUndoApproval
          ? `${displayName ? displayName + ' v' : 'V'}olvió a estado pendiente. El saldo fue revertido.`
          : isUndoCreate
          ? `${label} ${displayName} fue eliminado/a correctamente.`
          : `${label} ${displayName} fue restaurado/a correctamente.`,
        duration: 6000,
      });
      removeGlobalUndoAction(action.undoKey);
      if (undoStack.length === 0) setOpen(false);
    } catch {
      toast({
        title: 'No se pudo deshacer',
        description: 'El tiempo para deshacer esta acción expiró o el servidor se reinició.',
        variant: 'destructive',
        duration: 6000,
      });
      removeGlobalUndoAction(action.undoKey);
    } finally {
      setRestoringKey(null);
    }
  }, [queryClient, toast]);

  const hasActions = stack.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`relative h-8 w-8 transition-colors ${
            hasActions
              ? 'text-orange-600 hover:text-orange-700 hover:bg-orange-50'
              : 'text-muted-foreground/40 hover:text-muted-foreground/60 hover:bg-transparent cursor-default'
          }`}
          title={hasActions ? `Deshacer (${stack.length})` : 'Sin acciones para deshacer'}
          data-testid="button-global-undo"
          disabled={!hasActions}
        >
          <Undo2 className="h-4 w-4" />
          {hasActions && (
            <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-orange-500 text-[10px] font-bold text-white flex items-center justify-center">
              {stack.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0" data-testid="undo-popover">
        <div className="px-3 py-2 border-b">
          <p className="text-sm font-semibold">Deshacer acciones recientes</p>
          <p className="text-xs text-muted-foreground">Se eliminan automáticamente a los 60s</p>
        </div>
        <div className="py-1">
          {stack.length === 0 ? (
            <p className="text-sm text-muted-foreground px-3 py-3 text-center">No hay acciones para deshacer</p>
          ) : (
            stack.map((action) => {
              const label = ENTITY_LABELS[action.entityType] || action.entityType;
              const displayName = action.entityName || '';
              const isRestoring = restoringKey === action.undoKey;
              return (
                <div
                  key={action.undoKey}
                  className="flex items-center justify-between px-3 py-2 hover:bg-muted/50 gap-2"
                  data-testid={`undo-item-${action.undoKey}`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Trash2 className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {label}{displayName ? `: ${displayName}` : ''}
                      </p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {timeAgo(action.expiresAt)}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleRestore(action)}
                    disabled={isRestoring}
                    className="flex-shrink-0 text-xs h-7 px-2 border-orange-200 text-orange-600 hover:bg-orange-50 hover:text-orange-700"
                    data-testid={`button-undo-${action.undoKey}`}
                  >
                    {isRestoring ? '...' : 'Deshacer'}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
