// Configura un DOM (jsdom) sobre el entorno de Node para poder montar y
// ejercitar componentes React reales en los tests que corren con
// `npx tsx --test server/*.test.ts`.
//
// Por qué es necesario: Radix UI (la base de los Dialog de shadcn) usa APIs del
// navegador en sus efectos — construye CustomEvent, recorre el árbol con
// NodeFilter/TreeWalker, mide elementos, etc. Node ya define algunos globals
// (Event, CustomEvent) en SU PROPIO realm, distinto al de jsdom; si Radix usa el
// CustomEvent de Node y lo despacha sobre un nodo de jsdom, jsdom lo rechaza
// ("parameter 1 is not of type 'Event'"). Por eso se FUERZA la copia de los
// constructores DOM/Event desde la ventana de jsdom al global, pisando los de
// Node, para que todo viva en el mismo realm.
//
// Importar este módulo tiene efecto colateral (instala los globals). Debe
// importarse ANTES de cargar react-dom/client o cualquier componente.

import { JSDOM } from 'jsdom';

export interface JsdomEnv {
  window: import('jsdom').DOMWindow;
}

let env: JsdomEnv | null = null;

export function setupJsdom(): JsdomEnv {
  if (env) return env;

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const w = dom.window as any;
  const g = globalThis as any;

  // Copiar solo FUNCIONES (constructores) cuyo nombre sea claramente DOM/Event,
  // forzando la sobreescritura para unificar el realm. No se copian props de
  // datos ni getters para evitar recursión infinita o referencias circulares.
  const allow = new Set([
    'NodeFilter',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'DOMParser',
    'XMLSerializer',
    'getSelection',
  ]);
  for (const k of Object.getOwnPropertyNames(w)) {
    const v = w[k];
    if (typeof v !== 'function') continue;
    if (
      allow.has(k) ||
      /(?:Element|Event|Observer)$/.test(k) ||
      /^(?:HTML|SVG|Node|DOM|CSS|Document|Text|Comment|Range|Window)/.test(k)
    ) {
      try {
        g[k] = v;
      } catch {
        // algunas props son de solo lectura; ignorarlas
      }
    }
  }

  g.window = w;
  g.document = w.document;
  g.navigator = w.navigator;

  // React necesita esta bandera para permitir act() fuera de un test runner
  // de React.
  g.IS_REACT_ACT_ENVIRONMENT = true;

  // Polyfills que jsdom no implementa pero Radix/shadcn pueden tocar.
  if (!w.matchMedia) {
    w.matchMedia = () => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    });
  }
  g.matchMedia = w.matchMedia;

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.ResizeObserver = ResizeObserverStub;
  w.ResizeObserver = ResizeObserverStub;

  w.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  w.HTMLElement.prototype.hasPointerCapture = function hasPointerCapture() {
    return false;
  };
  w.HTMLElement.prototype.releasePointerCapture = function releasePointerCapture() {};

  env = { window: w };
  return env;
}
