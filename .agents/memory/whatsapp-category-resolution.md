---
name: WhatsApp bot — resolución de categoría
description: Precedencia con que el bot de WhatsApp decide la categoría de un movimiento y cómo el usuario puede cambiarla por mensaje.
---

# Resolución de categoría en el bot de WhatsApp

La categoría de un movimiento se decide en un único punto del flujo (igual para
texto y para audio transcripto). Regla de **precedencia**:

1. **Contenido del mensaje** (source `'explicit'`): se le pide a la IA el nombre
   EXACTO de una categoría del catálogo real de la org, o nada. Tiene prioridad.
2. **Preferencia** del usuario (source `'preference'`).
3. **Patrón histórico** (source `'habitual'`): fallback final.

**Why:** la categoría dicha por el usuario debe ganar. Antes nunca se leía del
mensaje y todo caía en patrón/preferencia, así que audio y texto registraban todo
en la misma categoría y no se podía corregir.

**How to apply:** si tocás esta lógica, respetá la precedencia. La etiqueta del
resumen muestra "(habitual)"/"(preferida)" según el source; con `'explicit'` no
muestra sufijo.

## Cambiar categoría por mensaje
La detección de intención de edición reconoce categoría cuando el mensaje trae la
palabra "categoría", verbos de clasificación ("ponelo en X", "metelo en X",
"clasificalo como X"), o frases ambiguas "es/era/va para X".

**Guardrail clave:** "es para X" SÍ es categoría (requisito del bug), pero NO
cuando X empieza por cliente/proveedor/cuenta/banco/caja/tarjeta — esas frases
apuntan a otra entidad, no a la categoría. Tener cuidado de no colisionar con la
detección de cuenta (que corre antes).

## Tests
Función pura de detección de intención: test rápido sin IA/DB. El test de
resolución completa usa IA real (lento, ~1 min).
Runner del proyecto: `npx tsx --test tests/<archivo>` (no hay script `test` en
package.json).
