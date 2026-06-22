---
name: IVA por producto — propagación al sistema
description: Dónde el IVA por producto (products.ivaAliquot) impacta y dónde NO, al emitir/cargar/reportar.
---

El campo `products.ivaAliquot` (default 21%) NO se propaga solo a todo el sistema. Mapa real:

- **Emisión factura multi-producto** (2+ renglones, hay `transaction_items`): EmitInvoiceModal lee `product.ivaAliquot` por renglón del detalle enriquecido. Funciona.
- **Emisión factura single-product** (la venta común guarda `transaction.productId`, SIN `transaction_items`): el modal cae a la rama `else`. Para que use el IVA del producto el detalle `/api/transactions/:id` debe exponer `product.ivaAliquot` en el objeto `product` single (no solo en `items[]`), y el modal lo lee de `txDetail.product.ivaAliquot`.
- **Alta en transaction-wizard**: `handleProductSelect` setea `form.invoiceIvaAliquot` desde el producto; al deseleccionar hay que limpiarlo. El paso de emisión del wizard siembra desde `invoiceIvaAliquot`.
- **Impuestos (taxes.ts/impuestos.tsx)**: calcula del snapshot de la tx (`invoiceIvaAmount`/`invoiceIvaAliquot`), NO del producto. Se corrige solo si el IVA del producto llega a la factura emitida.
- **Presupuestos (quoteItems) y transaction_items**: NO tienen columna de IVA por renglón. La emisión multi-producto lee el IVA del producto en vivo al emitir, no de ítems guardados.

**Precedencia de alícuota al sembrar**: override manual guardado (`invoiceIvaAliquot`) > IVA del producto > default del emisor. Siempre gated por `emitterDiscriminatesIva` (Monotributo/Exento = Factura C fuerza 0%).

**Cuidado con 0%**: un producto exento (IVA 0) es válido; el seed del wizard debe aceptar alícuota explícita >= 0, no solo > 0, o un 0% legítimo se pisa con 21% para RI.
