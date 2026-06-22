// Regression guard — fetchWithAuth ya antepone API_BASE = '/api'.
//
// Un día se filtró un endpoint que arrancaba con '/api/' (en useMembers,
// y también en ai-assistant.tsx + subscription-required.tsx). El
// resultado era una URL '/api/api/...' que el server respondía con el
// index.html de Vite (200 OK, HTML), entonces res.json() lanzaba y la
// query terminaba con [] silenciosamente — ocultando la columna
// "Creado por" de Movimientos y el bloque "Por miembro del equipo" de
// Reportes sin ningún error visible.
//
// Este test recorre el código del cliente y rompe si vuelve a aparecer
// una llamada del estilo `fetchWithAuth('/api/...')`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_SRC = join(process.cwd(), 'client', 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(full);
  }
  return acc;
}

describe('fetchWithAuth — endpoint prefix guard', () => {
  it('ningún archivo del cliente llama a fetchWithAuth con un endpoint que empiece con "/api/"', () => {
    const files = walk(CLIENT_SRC);
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    // Matchea `fetchWithAuth('/api/...`, `fetchWithAuth("/api/...` y la
    // variante con template literal `fetchWithAuth(\`/api/...` (esta
    // última fue la que se nos escapó la primera vez en
    // ai-assistant.tsx). Aceptamos opcionalmente la URL sin "/" inicial
    // por si alguien escribe 'api/...' literal.
    // No queremos falsos positivos por mencionar la cadena en comentarios,
    // así que ignoramos líneas cuyo trim arranca con "//" o "*".
    const re = /fetchWithAuth\s*\(\s*['"`]\/?api\//;

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (re.test(line)) {
          offenders.push({ file: file.replace(process.cwd() + '/', ''), line: idx + 1, text: trimmed });
        }
      });
    }

    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  - ${o.file}:${o.line}  ->  ${o.text}`)
        .join('\n');
      assert.fail(
        `Encontradas ${offenders.length} llamada(s) a fetchWithAuth con prefijo "/api/" duplicado.\n` +
          `fetchWithAuth ya antepone API_BASE='/api', así que el endpoint debe empezar SIN "/api".\n` +
          `Resultado actual: la URL queda como "/api/api/..." y el server responde el index.html,\n` +
          `por lo que res.json() rompe y la query devuelve [] silenciosamente.\n\n` +
          detail,
      );
    }
  });

  it('ningún archivo del cliente trata el resultado de fetchWithAuth como un Response (.ok / .json())', () => {
    // fetchWithAuth devuelve el JSON YA PARSEADO (Promise<unknown>), no un
    // Response object. Si alguien escribe:
    //   const res = await fetchWithAuth('/foo');
    //   if (!res.ok) return [];
    //   return res.json();
    // entonces `res.ok` es undefined → !undefined = true → devuelve []
    // SIEMPRE, descartando el body real. Eso fue exactamente lo que rompió
    // useMembers (Reportes / Movimientos): el endpoint funcionaba pero el
    // hook devolvía [] y el bloque "Por miembro del equipo" nunca aparecía.
    //
    // Heurística: para cada declaración `const|let|var <name> = await
    // fetchWithAuth(...)`, sólo escaneamos las próximas SCOPE_LINES líneas
    // buscando `<name>.ok` o `<name>.json(`. Esto captura el patrón típico
    // (chequeo inmediato post-await) sin chocar con reasignaciones del mismo
    // identificador a `fetch()` directo más abajo en el archivo.
    const SCOPE_LINES = 8;
    const files = walk(CLIENT_SRC);
    const offenders: Array<{ file: string; line: number; text: string; varName: string }> = [];
    const declRe = /(?:const|let|var)\s+(\{[^}]*\}|\w+)\s*=\s*await\s+fetchWithAuth\s*\(/;

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        const m = line.match(declRe);
        if (!m) return;
        const name = m[1];
        // Soportamos destructuring (`const { url } = await fetchWithAuth(...)`):
        // ahí no hay un identificador escalar para chequear `.ok`, así que lo
        // ignoramos.
        if (name.startsWith('{')) return;
        const usageRe = new RegExp(`\\b${name}\\.(ok|json\\s*\\()`);
        const end = Math.min(lines.length, idx + 1 + SCOPE_LINES);
        for (let j = idx + 1; j < end; j++) {
          const probe = lines[j];
          const trimmed = probe.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
          if (usageRe.test(probe)) {
            offenders.push({
              file: file.replace(process.cwd() + '/', ''),
              line: j + 1,
              text: trimmed,
              varName: name,
            });
          }
        }
      });
    }

    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  - ${o.file}:${o.line}  (var "${o.varName}")  ->  ${o.text}`)
        .join('\n');
      assert.fail(
        `Encontrados ${offenders.length} uso(s) de \`.ok\` o \`.json()\` sobre el resultado de fetchWithAuth.\n` +
          `fetchWithAuth devuelve el JSON YA PARSEADO, no un Response. \`res.ok\` siempre es undefined,\n` +
          `lo que hace que \`if (!res.ok) return []\` descarte SIEMPRE la respuesta del server.\n` +
          `Usá directamente el valor devuelto: const data = await fetchWithAuth('/x'); ...\n\n` +
          detail,
      );
    }
  });
});
