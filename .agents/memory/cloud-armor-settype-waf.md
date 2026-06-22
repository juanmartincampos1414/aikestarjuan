---
name: Cloud Armor WAF bloquea substring "settype" (y funciones PHP) en bodies
description: En deploys de Replit (Cloud Run + Google Cloud Armor), el WAF de borde corta requests cuyo body contiene substrings de funciones PHP de alto riesgo (OWASP CRS 933150), incluso dentro de NOMBRES de claves JSON.
---

# WAF de borde (Google Cloud Armor) bloquea "settype" y otras funciones PHP

**Síntoma:** un POST/PATCH devuelve `403` con `content-type: text/html` (`<!doctype html>...403 Forbidden`) y **sin** header `x-powered-by: Express`. El request nunca llega a Express. En el front aparece toast genérico "Forbidden". Un payload más chico al mismo endpoint sí llega a Express (403 JSON de CSRF, con `x-powered-by: Express`).

**Causa raíz:** el deploy corre detrás de Google Cloud Armor con OWASP CRS. La regla 933150 ("high-risk PHP function name") matchea, **case-insensitive y como subcadena**, nombres de funciones PHP en el body crudo — incluido `settype`. La clave JSON `assetType` contiene la subcadena `settype`, así que TODO movimiento (que siempre manda `assetType`) era cortado en el borde. Confirmado por bisección con curl: bloquean `assetType`, `assettype`, `ssetType`, `setType`, `qqssetTypeqq`; pasan `asset`, `asset_type`, `assetTyp`, `Type`, `etType`. Común = `settype`.

**Cómo diagnosticar:** curl directo a producción con payload completo vs mínimo. Mirar `content-type` y `x-powered-by` de la respuesta 403. text/html + sin x-powered-by = WAF de borde, no Express/CSRF. Bisecar el body por grupos de campos hasta aislar la clave/valor disparador.

**Fix aplicado:** renombrar la clave en el cable a una variante sin la subcadena (`asset_type` con guion bajo pasa el WAF) y mapearla de vuelta en el server. Cliente: `renameAssetTypeKey` en `client/src/lib/api.ts` (transactionAPI.create/update). Server: `normalizeAssetTypeKey` en `server/routes/transactions.ts` (handlers POST y PATCH), acepta ambos nombres por compat.

**Why:** no se puede desactivar el Cloud Armor de la plataforma desde el código; renombrar el campo es el único fix bajo nuestro control y es validable contra el WAF real con curl antes de republicar.

**How to apply / prevención:** evitar nombres de campos (claves JSON, query params) que contengan subcadenas de funciones PHP peligrosas: `settype`, `system`, `exec`, `passthru`, `popen`, `proc_open`, `shell_exec`, `eval`, `assert`, etc. Aplica a claves Y valores. Si aparece un 403 text/html sin x-powered-by tras publicar, sospechar de esto primero.
