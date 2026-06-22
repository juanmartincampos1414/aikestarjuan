---
name: Generación de PDF de presupuestos
description: Cómo y por qué los presupuestos (Oficina) generan su PDF en el cliente con jsPDF y de dónde salen los datos del membrete.
---

El PDF de un presupuesto se genera en el cliente con `jsPDF` (import dinámico) y se
descarga con `doc.save()`, NO con el diálogo de impresión del navegador.

**Why:** un primer intento usó `window.open` + `window.print()`, pero el usuario
reportó que eso abre "Imprimir" y no descarga un archivo. La expectativa es una
descarga directa de `.pdf`.

**How to apply:**
- El logo del membrete sale de `organizations.logoUrl`; se absolutiza con
  `window.location.origin` si es ruta relativa, y se rasteriza vía `Image` +
  `<canvas>`. Si es cross-origin sin CORS, `canvas.toDataURL` lanza (canvas
  "tainted"): capturarlo y generar el PDF SIN logo. No romper el flujo por esto.

**Datos de contacto del membrete (decisión durable):** email y teléfono se toman
de la organización (`organizations.contactEmail` / `contactPhone`, editables por
el owner) con **fallback** a los del usuario que descarga el PDF. El nombre de
contacto sigue siendo el del usuario emisor; el nombre de la empresa es
`organizations.name`.
**Why:** distintos miembros emiten presupuestos de la misma empresa; los datos de
contacto deben ser de la empresa, no de quien aprieta el botón, pero sin obligar a
cargarlos (por eso el fallback al usuario).
