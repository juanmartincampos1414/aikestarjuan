---
name: Testear componentes React/Radix bajo tsx node:test
description: Cómo montar componentes shadcn/Radix en jsdom dentro de `npx tsx --test server/*.test.ts` sin que exploten por globals faltantes o realm mismatch.
---

Se pueden escribir tests de UI REALES (montar el componente, clickear data-testids,
verificar transiciones del DOM) en `server/*.test.ts` porque `tsx` resuelve los
alias `@/` y `@shared/` del tsconfig, así que un test en `server/` puede importar
componentes de `client/src`.

**Setup obligatorio** (ver `server/testJsdomEnv.ts`, `setupJsdom()`):
- Crear un `JSDOM` y FORZAR la copia de los constructores DOM/Event de
  `dom.window` a `globalThis`, PISANDO los de Node.
  - **Por qué:** Node ya define `Event`/`CustomEvent` en su propio realm. Si se
    salta copiarlos (`if (k in g) continue`), Radix construye un `CustomEvent` de
    Node y al despacharlo sobre un nodo jsdom falla con
    `"parameter 1 is not of type 'Event'"` → `AggregateError` vacío en `act()`.
  - Copiar solo FUNCIONES cuyo nombre matchee DOM/Event (`/Element$|Event$|Observer$/`,
    `/^(HTML|SVG|Node|DOM|CSS|Document|Text|Range|Window)/`) + allowlist
    (`NodeFilter`, `getComputedStyle`, `requestAnimationFrame`, ...). Copiar TODO
    el window causa `Maximum call stack` (getters circulares).
- Polyfills que jsdom no trae y Radix toca: `ResizeObserver`, `matchMedia`,
  `HTMLElement.prototype.scrollIntoView`, `hasPointerCapture`, `releasePointerCapture`.
- `globalThis.IS_REACT_ACT_ENVIRONMENT = true` para usar `act()` de React 19.
- Importar React / react-dom/client / el componente con `await import(...)` DESPUÉS
  del setup (no estático), para que lean los globals ya instalados.

**Render e interacción:**
- `createRoot(container)` con `container` appendeado a `document.body`. Los Dialog
  de Radix portalean a `document.body`; los clicks por `dispatchEvent(new window.MouseEvent('click',{bubbles:true}))` sí llegan a los handlers de React a través del portal.
- Envolver render y cada dispatch de evento en `await act(async () => { ... })`.
- El botón de cierre X de shadcn no tiene testid: buscarlo por `textContent` que
  incluya `"Close"` (tiene un `<span class="sr-only">Close</span>`).

**How to apply:** cuando haga falta un test de navegación/UI de un componente
shadcn/Radix sin Playwright. Errores tipo `X is not defined` (MutationObserver,
NodeFilter, HTMLInputElement) = falta agregar ese constructor al copiado de jsdom.
