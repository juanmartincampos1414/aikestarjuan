---
name: Importación clientes/proveedores — editar filas en la vista previa
description: Cómo y por qué las filas editadas se envían con claves canónicas, y por qué la primera vista previa usa las filas originales.
---

# Editar filas antes de confirmar la importación

Los diálogos de import de Clientes y Proveedores (mismo patrón, dos archivos)
permiten editar las celdas de la vista previa antes de confirmar. El estado
`editableRows` (claves canónicas) es la única fuente de verdad que alimenta
tanto la revalidación (dryRun=true) como el confirmar (dryRun=false).

**Regla:** las filas editadas se envían al servidor con las claves canónicas
exactas (los `*_EXPECTED_HEADERS`), no con los encabezados arbitrarios del
Excel. El helper `extractCanonicalImportRow` replica la normalización del
servidor (NFD sin tildes + trim + lowercase) para mapear cada fila cruda a esas
claves.

**Why:** el servidor (`handleContactBulkImport`) lee columnas matcheando por
encabezado normalizado. Si se reenvían filas con claves nuevas distintas a la
clave real detectada, `getCol` lee la clave real y se pierde la edición. Enviar
claves canónicas evita ese desajuste.

**Why (2):** la PRIMERA vista previa se sigue enviando con las filas originales
del archivo (no canónicas) a propósito, para preservar la detección
`MISSING_NAME_COLUMN`. Si se enviaran canónicas, siempre existiría la clave
'Nombre' y nunca se dispararía ese aviso útil. `editableRows` se arma recién
tras esa primera vista previa exitosa.

**How to apply:** cualquier cambio futuro al matching de encabezados del
servidor debe reflejarse en `extractCanonicalImportRow` (ambos archivos). El
confirmar gatea con `!dirty`: tras editar hay que revalidar para que los
contadores coincidan con lo que se importa.
