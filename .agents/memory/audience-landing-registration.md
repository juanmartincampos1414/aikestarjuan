---
name: Registro filtrado por audiencia (landings de anuncios)
description: Cómo funciona la segmentación de planes por ?audience= en /register sin romper el registro común.
---

La audiencia viaja por query string `?audience=pymes|emprendedores|parejas` hacia `/register`.
`auth.tsx` mapea con `AUDIENCE_PLANS` a una lista de planes permitidos y la pasa como
prop opcional `allowedPlans` a `PlansShowcase`. Sin audiencia válida la prop queda
`undefined` y se muestran TODOS los planes (registro común intacto). `PlansShowcase`
oculta la sección personal/empresa cuando su lista filtrada queda vacía. Si la audiencia
tiene un único plan (parejas), un `useEffect` autoselecciona y salta al formulario.

**Why:** requisito firme de la tarea — el registro común no debe cambiar y Stripe/checkout
no se toca; toda la segmentación es solo de presentación vía URL.

**How to apply:**
- Al cambiar entre pestañas Login/Registro hay que **preservar `?audience=`** en
  `setLocation` (si no, se pierde la segmentación y la autoselección de parejas).
- El bypass de rutas públicas de landings en `App.tsx` corre ANTES del gate de sesión
  y normaliza el trailing slash; las landings son accesibles con o sin sesión.
