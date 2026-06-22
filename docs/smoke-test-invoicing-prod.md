# Smoke test guiado de facturación electrónica (post-deploy)

Esta checklist se corre **después de cada deploy a producción** que toque el
módulo de facturación electrónica (rutas `/invoicing`, wizard de transacciones,
sección "Facturador" en Configuración, página de Facturas).

Objetivo: verificar contra **ARCA real** (no sandbox) que los tres caminos
críticos funcionan antes de habilitar la feature a usuarios pagos.

> ⚠️ Importante: este test **emite comprobantes ARCA reales** asociados al
> CUIT que se use para activar el facturador. Usar siempre un CUIT de
> testing del equipo o uno propio, nunca el CUIT de un cliente. Los
> comprobantes generados quedan en la cuenta ARCA del CUIT y son válidos
> fiscalmente — no se pueden "borrar", solo se pueden anular con NC.

---

## Pre-requisitos

Antes de empezar, confirmar:

- [ ] La app está publicada y se accede por su URL de producción
      (ej. `https://app.aikestar.com`).
- [ ] En el panel de Replit Deployments, las siguientes variables están
      cargadas en el ambiente de producción:
  - `FACTURITA_API_KEY`
  - `INVOICING_ENCRYPTION_KEY`
  - `DATABASE_URL`
  - `SENDGRID_API_KEY` y `SENDGRID_FROM_EMAIL` (para que se envíen los
    PDFs por mail si lo probás).
- [ ] Existe una **organización de testeo** en producción con un usuario
      admin al que tengas acceso. Si no, crearla desde el flujo normal de
      registro y dejarla marcada mentalmente como "datos de prueba" para
      el Paso 6.
- [ ] Tenés a mano:
  - Un **CUIT real** (preferiblemente del equipo) con su clave fiscal
    de ARCA.
  - Un **cliente de prueba** (puede ser otro CUIT del equipo o un
    consumidor final con CUIT 0).
  - Un **proveedor de prueba** (mismo criterio).

Tiempo estimado del test completo: **15–20 minutos**.

---

## Paso 1 — Activar el facturador en producción

1. Iniciar sesión en la app con el usuario admin de la organización
   de testeo.
2. Ir a **Configuración → Facturador** (`/settings?tab=facturador`).
3. Si ya está activado de un test anterior, hacer click en
   **"Desactivar"** primero y confirmar.
4. En el formulario:
   - **CUIT**: el CUIT real de testeo (sin guiones, 11 dígitos).
   - **Condición IVA**: la real del CUIT (responsable inscripto,
     monotributo, exento).
   - **Ambiente**: seleccionar **"Producción"**.
   - **Clave fiscal**: la clave fiscal de ARCA del CUIT (aparece
     sólo cuando el ambiente es Producción).
5. Click **"Activar facturación electrónica"**.

**Verificar:**
- [ ] Aparece una tarjeta verde con: **razón social** real (la que
      ARCA tiene asociada al CUIT), **CUIT**, **condición IVA**,
      ambiente **"Producción"** y al menos un **punto de venta**
      (ej. `0001`) listado como badge.
- [ ] Si en lugar de eso aparece un mensaje rojo, **copiar el texto
      exacto del error y abortar el smoke test**. Los errores más
      comunes están listados al final en "Si algo falla".

---

## Paso 2 — Emitir Factura a cliente

1. Ir a **Movimientos → Nuevo movimiento**.
2. Crear un **Ingreso**:
   - **Monto**: $100.
   - **Cliente**: el cliente de prueba.
   - **Categoría**: cualquier categoría de ingreso (ej. Ventas).
   - **Cuenta**: cualquier cuenta operativa.
3. Avanzar hasta el paso de "factura":
   - Marcar **"tiene factura electrónica"**.
   - Completar datos del receptor si no se autocompletaron
     (CUIT/DNI, condición IVA, dirección si aplica).
   - **Neto**: $100, **Alícuota IVA**: 21%. El IVA debería
     calcularse en $21 automáticamente.
4. Click **"Emitir"** en el paso final.

**Verificar:**
- [ ] Toast verde **"Factura emitida"** con número en formato
      `PPPP-NNNNNNNN` (ej. `0001-00000123`) y un **CAE** numérico
      de 14 dígitos.
- [ ] El movimiento aparece en la lista con el chip de factura.
- [ ] Ir a **Oficina → Facturas**, encontrar la factura recién
      emitida. Debe mostrar:
  - Badge **"Producción"** (no "Sandbox", no "Simulada").
  - Descargar el PDF y confirmar que **NO** tiene marca de agua
    "SIMULADO – SIN VALIDEZ FISCAL".
  - El PDF tiene CAE, código de barras/QR, y los datos del receptor.

---

## Paso 3 — Anular esa factura con Nota de Crédito

1. Desde el detalle de la factura recién emitida (o desde el
   movimiento), click **"Anular con nota de crédito"** (o el botón
   equivalente del flujo de cancelación).
2. Confirmar la anulación.

**Verificar:**
- [ ] Toast **"Nota de Crédito emitida"** con número propio
      (`PPPP-NNNNNNNN`) y CAE.
- [ ] En **Oficina → Facturas** aparece la NC ligada visualmente
      a la factura original.
- [ ] El movimiento original queda marcado como **anulado** /
      cancelado.
- [ ] En la cuenta ARCA del CUIT (entrar a la web de ARCA con
      clave fiscal y mirar "Comprobantes emitidos") aparecen
      ambos: la factura del Paso 2 y la NC del Paso 3.

---

## Paso 4 — Emitir NC standalone a proveedor

Este caso es el más delicado: por una limitación de nuestro proveedor
de facturación electrónica, **emitir una NC a proveedor genera 2
comprobantes en ARCA**: la NC (la que importa al usuario) y una
factura "shadow" interna que necesitamos para tener un comprobante
origen al cual ligar la NC. Esto está documentado en `replit.md` y
hay que avisarle al usuario al onboardear.

1. Ir a **Movimientos → Nuevo movimiento**.
2. Crear un **Egreso**:
   - **Monto**: $100.
   - **Proveedor**: el proveedor de prueba.
   - **Categoría**: cualquier categoría de egreso.
3. En el paso de factura, marcar **"tiene factura electrónica"**.
4. En el bloque ámbar **"Tipo de comprobante a proveedor"** elegir
   **"Nota de Crédito"** (debería estar seleccionado por defecto en
   producción).
5. Completar datos del receptor (proveedor) y emitir.

**Verificar:**
- [ ] Toast **"Nota de Crédito emitida"** con número
      `PPPP-NNNNNNNN` y CAE.
- [ ] En la cuenta ARCA del CUIT aparecen **2 comprobantes nuevos**:
  - La **Nota de Crédito** con el monto del movimiento (la que
    importa).
  - Una **Factura "shadow"** del mismo monto, emitida segundos
    antes que la NC. Es esperado — no es un bug.
- [ ] En Aikestar el movimiento queda con tipo de comprobante
      `NCA` / `NCB` / `NCC` (según condición IVA del proveedor) y
      **NO** marcado como simulado.

---

## Paso 5 — Confirmar que ND a proveedor sigue bloqueada

La emisión de **Nota de Débito a proveedor** no está soportada por
el proveedor de facturación en producción. La task #152 deshabilita
el botón en la UI; este paso confirma que la barrera funciona.

1. Repetir los pasos 1–3 del Paso 4 (crear un Egreso $100 y llegar
   al bloque ámbar "Tipo de comprobante a proveedor").
2. Intentar clickear **"Nota de Débito"**.

**Verificar (escenario esperado, post-task #152):**
- [ ] El botón "Nota de Débito" aparece **atenuado** (gris, opacidad
      baja, cursor "no permitido").
- [ ] No se puede clickear; al pasar el mouse aparece un tooltip
      explicativo.
- [ ] Debajo de los botones se ve el texto **"Nota de Débito a
      proveedor todavía no está disponible automáticamente en
      producción. Emitila desde ARCA y registrala como comprobante
      manual."**
- [ ] El preview de letra del comprobante muestra **"Nota de
      Crédito X"** (nunca "ND…").

**Escenario de fallback (si por alguna razón el botón está activo):**
- [ ] Al emitir, el backend devuelve error `501 NOT_IMPLEMENTED`
      con un mensaje pidiendo emitir manualmente desde ARCA.
- [ ] Si esto pasa, **es bug**: anotar y crear un task para
      revisar por qué el guard de UI no se aplicó.

---

## Paso 6 — Limpieza

- [ ] **No anular el facturador en ARCA** — eso es un trámite
      separado contra ARCA y no se hace desde Aikestar.
- [ ] En Aikestar, en el panel admin (o manualmente), marcar la
      organización de testeo como "datos de prueba" o eliminar los
      4 movimientos generados (Paso 2, Paso 3, Paso 4 + factura
      shadow asociada) para que no contaminen reportes ni KPIs de
      facturación.
- [ ] Los comprobantes ya emitidos en ARCA quedan ahí — son válidos
      fiscalmente y no se borran. Se pueden ignorar a fines
      contables si el CUIT de testeo se usa solo para esto.

---

## Validación técnica opcional (para alguien con acceso a la DB)

Si querés confirmar que los datos quedaron bien guardados a nivel
base de datos (no solo en la UI), conectarse a la DB de producción
con cualquier cliente SQL usando `DATABASE_URL` y ejecutar:

```sql
-- Movimiento del Paso 2 (Factura cliente)
SELECT id, invoice_voucher_id, invoice_cae,
       invoice_emission_status, invoice_simulated, invoice_doc_type
FROM transactions
WHERE id = '<id del movimiento del Paso 2>';
```

Esperado:
- `invoice_voucher_id` con formato `PPPP-NNNNNNNN` (no nulo).
- `invoice_cae` con 14 dígitos (no nulo).
- `invoice_emission_status = 'emitted'`.
- `invoice_simulated = false`.
- `invoice_doc_type` en `('FA', 'FB', 'FC')`.

```sql
-- Movimiento del Paso 3 (NC ligada a la factura)
SELECT id, invoice_credit_note_uuid, invoice_emission_status
FROM transactions
WHERE id = '<id del movimiento del Paso 2>';
```

Esperado:
- `invoice_credit_note_uuid` apuntando al UUID de la NC del Paso 3.

```sql
-- Movimiento del Paso 4 (NC standalone proveedor)
SELECT id, invoice_doc_type, invoice_voucher_id, invoice_cae,
       invoice_simulated
FROM transactions
WHERE id = '<id del movimiento del Paso 4>';
```

Esperado:
- `invoice_doc_type` en `('NCA', 'NCB', 'NCC')`.
- `invoice_voucher_id` y `invoice_cae` no nulos.
- `invoice_simulated = false`.

Si algún campo está en `NULL` o en `simulated=true` cuando el
ambiente es Producción, **es bug** — anotar y abrir un task.

---

## Resultado del test

Al final, escribir en el canal de equipo (o donde corresponda) un
mensaje del tipo:

> **Smoke test facturación post-deploy [fecha]**
> ✅ Pasos 1, 2, 3, 4, 5 OK. Producción habilitada para usuarios.

o bien:

> **Smoke test facturación post-deploy [fecha]**
> ❌ Falló en Paso N: [mensaje exacto del error / screenshot].
> No habilitar facturación a usuarios hasta resolver.

---

## Si algo falla

### Cómo leer logs de producción

En el panel de Replit Deployments del proyecto, abrir la pestaña
**"Logs"** del deployment activo. Buscar entradas con:
- `[invoicing]` — operaciones del módulo de facturación.
- `ERROR` o `Facturita` — errores del proveedor.
- El **timestamp** del momento exacto en que falló el paso.

### 3 causas más probables de error

1. **Secretos faltantes o desactualizados en el deploy**
   - Síntoma: error genérico tipo "no se pudo conectar al
     proveedor" o "INVOICING_ENCRYPTION_KEY missing".
   - Fix: verificar en Deployments → Secrets que estén
     `FACTURITA_API_KEY` e `INVOICING_ENCRYPTION_KEY`. Si se
     rotaron, los datos cifrados anteriores dejan de poder
     desencriptarse — habría que desactivar y reactivar el
     facturador.

2. **CUIT mal cargado o sin clave fiscal habilitada en ARCA**
   - Síntoma: el Paso 1 falla con mensaje del estilo "el CUIT no
     existe", "clave fiscal inválida" o "el CUIT no tiene servicio
     de facturación electrónica habilitado".
   - Fix: verificar en la web de ARCA que el CUIT tenga el servicio
     "Facturación Electrónica" / "Comprobantes en línea" habilitado
     y la clave fiscal sea de Nivel 3 o superior.

3. **Ambiente "Sandbox" seleccionado por error**
   - Síntoma: el Paso 1 funciona pero los comprobantes se emiten
     con badge "Sandbox" / "Simulada" y el PDF tiene marca de
     agua "SIMULADO".
   - Fix: desactivar el facturador y reactivarlo eligiendo
     **"Producción"**. No hay forma de "convertir" comprobantes
     sandbox a producción — los del test van a quedar marcados
     como sandbox y deben ignorarse.

### Si nada de lo anterior aplica

Capturar:
- Mensaje exacto del error (texto + screenshot).
- Paso en que falló.
- Logs de producción del minuto en que ocurrió.
- ¿Es la primera vez que se corre este test post-deploy, o el
  deploy anterior pasaba?

Y abrir un ticket / mensaje al equipo de ingeniería.
