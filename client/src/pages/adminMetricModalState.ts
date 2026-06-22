// Estado y transiciones del modal que se abre al clickear una tarjeta de métrica
// en el Panel de Administración.
//
// Igual que `adminMetricFilter.ts` (el criterio de pertenencia a cada métrica),
// esta lógica vive en su propio módulo SIN dependencias de React para que:
//   1. El componente `admin.tsx` la use como única fuente de verdad de las
//      transiciones del modal (abrir tarjeta, maximizar/restaurar, abrir el
//      detalle de un usuario, "Volver", cerrar).
//   2. Los tests la ejerciten DIRECTAMENTE (no una copia a mano que se
//      desactualice) y fijen el contrato de navegación: que "Volver" conserve
//      la métrica, que cerrar resetee todo (sin fuga entre sesiones) y que
//      reabrir arranque siempre limpio.
//
// El modal tiene tres ejes de estado independientes:
//   - `metric`: qué métrica/tarjeta está abierta (null = modal cerrado).
//   - `maximized`: si la ventana está maximizada o en tamaño normal.
//   - `selectedUser`: el usuario cuyo detalle se está viendo (null = lista).

import type { MetricFilter } from './adminMetricFilter';

// Genérico sobre el tipo de usuario para no acoplar este módulo a `AdminUser`
// (admin.tsx) ni obligar a los tests a construir el objeto completo.
export interface MetricModalState<TUser> {
  metric: MetricFilter;
  maximized: boolean;
  selectedUser: TUser | null;
}

// Estado del modal cerrado: la base limpia a la que se vuelve al cerrar y desde
// la que arranca cada apertura.
export function closedMetricModalState<TUser>(): MetricModalState<TUser> {
  return { metric: null, maximized: false, selectedUser: null };
}

export type MetricModalAction<TUser> =
  | { type: 'open'; metric: Exclude<MetricFilter, null> }
  | { type: 'toggleMaximize' }
  | { type: 'selectUser'; user: TUser }
  | { type: 'back' }
  | { type: 'close' };

export function metricModalReducer<TUser>(
  state: MetricModalState<TUser>,
  action: MetricModalAction<TUser>,
): MetricModalState<TUser> {
  switch (action.type) {
    case 'open':
      // Abrir una tarjeta SIEMPRE arranca limpio: en la lista (sin usuario
      // seleccionado) y en tamaño normal. Así un modal anterior maximizado o
      // con un detalle abierto no se "filtra" a la siguiente apertura.
      return { metric: action.metric, maximized: false, selectedUser: null };
    case 'toggleMaximize':
      return { ...state, maximized: !state.maximized };
    case 'selectUser':
      // Abre el detalle del usuario clickeado, conservando métrica y tamaño.
      return { ...state, selectedUser: action.user };
    case 'back':
      // "Volver" cierra el detalle PERO conserva la métrica (y el tamaño): se
      // vuelve a la lista de la misma tarjeta, no al panel de tarjetas.
      return { ...state, selectedUser: null };
    case 'close':
      // Cerrar el modal resetea los tres ejes para no dejar estado residual.
      return closedMetricModalState<TUser>();
    default:
      return state;
  }
}
