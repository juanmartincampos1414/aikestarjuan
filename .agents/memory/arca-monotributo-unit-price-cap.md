---
name: ARCA tope de precio unitario por ítem (monotributo / Factura C)
description: ARCA rechaza facturas de monotributo/exento cuyo precio unitario por renglón supera un tope; cómo se evita en el emisor.
---

ARCA (vía Facturitas) rechaza la emisión de una Factura C (emisor monotributo o
exento) cuando el **precio unitario de algún ítem** supera un tope (~$613.492 a
2026). El mensaje del proveedor llega como, por ejemplo: "unit_price 7000000.0
supera el máximo permitido para productos en monotributistas (613492)". El tope
es por **precio unitario**, no por total: subir la cantidad del renglón SÍ ayuda
(qty 12 × 583.333 = 7.000.000 con unit ≤ tope), igual que dividir en varios
ítems.

**Por qué:** Juan recibió ese rechazo al facturar $7.000.000 de monotributo en un
único ítem. El usuario NO quiere auto-split: prefiere cargar los ítems reales a
mano con un aviso que explique el tope.

**Cómo aplicar:**
- Constante `MONOTRIBUTO_MAX_UNIT_PRICE` en `shared/constants.ts` para el aviso
  preventivo (mantener sincronizada con ARCA, el valor cambia cada tanto).
- En `EmitInvoiceModal` el detalle es un array de ítems; se avisa y se bloquea
  "Emitir" si algún unitNet supera el tope para emisores Factura C.
- Cuando ARCA igual rechaza, el catch parsea el número real del mensaje
  (`/m[aá]ximo permitido[^()]*\((\d+)\)/i`) y muestra una explicación amigable.
- Regla de producto: **no inventar ítems ni cantidades** en facturas; el usuario
  carga los ítems reales. Cualquier ayuda es guía, no auto-generación.
