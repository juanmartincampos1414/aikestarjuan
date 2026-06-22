// Modal que se abre al clickear una tarjeta de métrica del Panel de
// Administración. Se extrajo de admin.tsx a su propio componente para poder
// testear su navegación de UI de forma aislada (server/admin-metric-modal-ui.test.ts)
// renderizándolo en jsdom y disparando clicks reales sobre sus data-testid,
// sin tener que montar toda la página de administración.
//
// El estado (qué métrica, maximizado, usuario seleccionado) lo gobierna el
// reducer de adminMetricModalState.ts; este componente solo lo refleja y
// despacha acciones (`open`/`toggleMaximize`/`selectUser`/`back`/`close`).

import React, { type Dispatch } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { ArrowLeft, Maximize2, Minimize2 } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { type MetricFilter, METRIC_MODAL_LABELS } from './adminMetricFilter';
import { type MetricModalAction } from './adminMetricModalState';

// Subconjunto de campos del usuario que el modal renderiza. `AdminUser`
// (admin.tsx) es estructuralmente asignable a esto, así que se pasa tal cual.
export interface MetricModalUser {
  id: string;
  email: string;
  name: string;
  accountType: string;
  isAdmin: boolean;
  createdAt: string;
  deletedAt: string | null;
  phoneNumber: string | null;
  phoneVerified: boolean | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscription: {
    planType: string;
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    paymentFailedAt: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
}

interface MetricUsersModalProps<TUser extends MetricModalUser> {
  metric: MetricFilter;
  maximized: boolean;
  selectedUser: TUser | null;
  users: TUser[];
  dispatch: Dispatch<MetricModalAction<TUser>>;
  renderPlanBadge: (planType: string | undefined) => React.ReactNode;
  renderStatusBadge: (user: TUser) => React.ReactNode;
  formatPhoneDisplay: (phone: string | null | undefined) => string;
}

export function MetricUsersModal<TUser extends MetricModalUser>({
  metric,
  maximized,
  selectedUser,
  users,
  dispatch,
  renderPlanBadge,
  renderStatusBadge,
  formatPhoneDisplay,
}: MetricUsersModalProps<TUser>) {
  return (
    <Dialog
      open={!!metric}
      onOpenChange={(open) => {
        if (!open) {
          dispatch({ type: 'close' });
        }
      }}
    >
      <DialogContent
        className={`flex flex-col ${maximized ? 'w-[95vw] max-w-[95vw] h-[90vh] max-h-[90vh]' : 'max-w-2xl max-h-[80vh]'}`}
        data-testid="dialog-metric-users"
      >
        <button
          type="button"
          onClick={() => dispatch({ type: 'toggleMaximize' })}
          className="absolute right-12 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          aria-label={maximized ? 'Restaurar tamaño' : 'Maximizar'}
          title={maximized ? 'Restaurar tamaño' : 'Maximizar'}
          data-testid="button-metric-modal-maximize"
        >
          {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>

        {selectedUser ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2 pr-16">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 -ml-2 text-muted-foreground hover:text-foreground"
                  onClick={() => dispatch({ type: 'back' })}
                  data-testid="button-metric-modal-back"
                >
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Volver
                </Button>
              </div>
              <DialogTitle data-testid="text-user-detail-name">{selectedUser.name}</DialogTitle>
              <DialogDescription data-testid="text-user-detail-email">{selectedUser.email}</DialogDescription>
            </DialogHeader>
            <div className="overflow-y-auto -mx-1 px-1">
              <div className="flex flex-wrap items-center gap-2 mb-4">
                {renderPlanBadge(selectedUser.subscription?.planType)}
                {renderStatusBadge(selectedUser)}
                {selectedUser.isAdmin && (
                  <Badge variant="outline" data-testid="badge-user-detail-admin">Admin</Badge>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div>
                  <Label className="text-xs text-muted-foreground">Celular</Label>
                  <p className="break-all" data-testid="text-user-detail-phone">
                    {selectedUser.phoneNumber ? (
                      <>
                        {formatPhoneDisplay(selectedUser.phoneNumber)}
                        {selectedUser.phoneVerified && (
                          <span className="ml-2 inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-green-50 text-green-700 border border-green-200">
                            Verificado
                          </span>
                        )}
                      </>
                    ) : '—'}
                  </p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Tipo de cuenta</Label>
                  <p data-testid="text-user-detail-account-type">{selectedUser.accountType || '—'}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Registrado</Label>
                  <p data-testid="text-user-detail-created">
                    {format(new Date(selectedUser.createdAt), "dd/MM/yyyy HH:mm", { locale: es })}
                  </p>
                </div>
                {selectedUser.deletedAt && (
                  <div>
                    <Label className="text-xs text-muted-foreground">Eliminada</Label>
                    <p className="text-red-500" data-testid="text-user-detail-deleted">
                      {format(new Date(selectedUser.deletedAt), "dd/MM/yyyy HH:mm", { locale: es })}
                    </p>
                  </div>
                )}
                <div>
                  <Label className="text-xs text-muted-foreground">Estado de suscripción</Label>
                  <p data-testid="text-user-detail-sub-status">{selectedUser.subscription?.status || '—'}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Período actual</Label>
                  <p data-testid="text-user-detail-period">
                    {selectedUser.subscription?.currentPeriodStart && selectedUser.subscription?.currentPeriodEnd
                      ? `${format(new Date(selectedUser.subscription.currentPeriodStart), "dd/MM/yyyy", { locale: es })} → ${format(new Date(selectedUser.subscription.currentPeriodEnd), "dd/MM/yyyy", { locale: es })}`
                      : '—'}
                  </p>
                </div>
                {selectedUser.subscription?.paymentFailedAt && (
                  <div>
                    <Label className="text-xs text-muted-foreground">Pago fallido</Label>
                    <p className="text-red-500" data-testid="text-user-detail-payment-failed">
                      {format(new Date(selectedUser.subscription.paymentFailedAt), "dd/MM/yyyy HH:mm", { locale: es })}
                    </p>
                  </div>
                )}
                <div>
                  <Label className="text-xs text-muted-foreground">Stripe Customer ID</Label>
                  <p className="break-all text-xs" data-testid="text-user-detail-stripe-customer">{selectedUser.stripeCustomerId || '—'}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Stripe Subscription ID</Label>
                  <p className="break-all text-xs" data-testid="text-user-detail-stripe-subscription">{selectedUser.stripeSubscriptionId || '—'}</p>
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="pr-16" data-testid="text-metric-modal-title">
                {metric ? METRIC_MODAL_LABELS[metric] : ''}
              </DialogTitle>
              <DialogDescription data-testid="text-metric-modal-count">
                {users.length} {users.length === 1 ? 'cuenta' : 'cuentas'}
              </DialogDescription>
            </DialogHeader>
            <div className="overflow-y-auto -mx-1 px-1">
              {users.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground" data-testid="text-metric-modal-empty">
                  No se encontraron usuarios
                </div>
              ) : (
                <div className="divide-y">
                  {users.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => dispatch({ type: 'selectUser', user })}
                      className="w-full flex items-center justify-between gap-3 py-2.5 text-left hover:bg-muted/50 rounded-md px-2 -mx-2 transition-colors cursor-pointer"
                      data-testid={`row-metric-modal-user-${user.id}`}
                    >
                      <div className="min-w-0">
                        <p className="font-medium truncate">{user.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        {renderPlanBadge(user.subscription?.planType)}
                        {renderStatusBadge(user)}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
