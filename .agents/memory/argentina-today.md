---
name: Fecha "hoy" en hora de Argentina
description: Por qué y cómo calcular el día calendario argentino en cliente y servidor sin corrimiento de zona horaria.
---

# Día "hoy" en hora de Argentina

**Regla:** para obtener el día calendario de HOY (formato `YYYY-MM-DD`) usar
`getArgentinaToday()` de `@shared/constants`. Nunca usar
`new Date().toISOString().split('T')[0]` ni `new Date().getMonth()/getFullYear()`
para una fecha que representa un día calendario que el usuario ve o que se guarda.

**Why:** la app es de uso argentino (UTC-3). `toISOString()` y los getters sin
timezone devuelven el día/mes/año en UTC, así que todo lo calculado entre
~21:00 y medianoche (hora AR) ya cayó al día siguiente en UTC. Esto hacía que
los movimientos cargados de noche quedaran con la fecha de mañana.

**How to apply:**
- El servidor corre en UTC; el mismo helper sirve en server y cliente, por eso
  vive en `shared/constants.ts`.
- Para año/mes: `const [y, m] = getArgentinaToday().split('-').map(Number)`.
- Las fechas de movimiento se guardan como el día argentino al mediodía (la app
  manda `YYYY-MM-DD` crudo y `parseLocalDate` lo fija al mediodía; el server, al
  no pasar por ese parser, debe construir el `Date` al mediodía del día AR).
  El mediodía evita cualquier corrimiento al mostrar la fecha ya guardada.

**Pendiente conocido (mismo tema, fuera de alcance):** los movimientos cargados
de noche ANTES de aplicar estos arreglos siguen con la fecha corrida un día.
Corregirlos requiere detectar los afectados (creados en franja nocturna AR con
fecha = día UTC) y restar un día, con revisión del usuario para no tocar fechas
elegidas a propósito.
