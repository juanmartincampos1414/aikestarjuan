---
name: FormLabel/FormControl requieren contexto FormField
description: Por qué primitivas shadcn de form crashean fuera de un FormField y qué usar en su lugar.
---

En este repo, las primitivas de `@/components/ui/form` (FormLabel, FormControl,
FormMessage, FormDescription) llaman internamente a `useFormField()`, que LANZA
("useFormField should be used within <FormField>") si no están dentro de un
`<FormField>`. El error solo aparece en runtime cuando ese subárbol se renderiza
(p. ej. al agregar una fila dinámica), no lo detecta tsc.

**Regla:** para labels/inputs fuera de `react-hook-form` (listas dinámicas de
renglones manejados con useState, no con form.control), usar el `<Label>` plano de
`@/components/ui/label`, NUNCA `<FormLabel>`. Mismos estilos, sin contexto requerido.

**Cómo aplica:** cualquier UI repetible (renglones de items, sub-formularios ad hoc)
que no esté envuelta en `<FormField control=... name=...>` debe evitar las
primitivas Form*. Caso real: renglones "Agregar otro producto" del transaction-wizard.
