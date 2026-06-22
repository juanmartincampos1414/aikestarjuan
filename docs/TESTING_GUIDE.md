# AIKESTAR - Guía de Testing Completa

## Información General
**Producto:** Aikestar - Sistema de Gestión Financiera con IA  
**Versión:** 1.0  
**Fecha:** Enero 2026

---

## 1. AUTENTICACIÓN

### 1.1 Registro de Usuario
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Registro cuenta personal | 1. Ir a /auth 2. Click "Crear cuenta" 3. Llenar email, nombre, contraseña 4. Seleccionar "Personal" | Cuenta creada, redirige a dashboard |
| Registro cuenta empresarial | 1. Igual que arriba 2. Seleccionar "Empresa" 3. Ingresar nombre de organización | Cuenta + org creadas |
| Email duplicado | Intentar registrar con email existente | Error: "Ya existe una cuenta con este email" |
| Campos vacíos | Dejar campos obligatorios vacíos | Error de validación |

### 1.2 Login
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Login exitoso | Email + contraseña correctos | Redirige a dashboard |
| Contraseña incorrecta | Email correcto + contraseña incorrecta | Error: "Email o contraseña incorrectos" |
| Email no existe | Email que no existe en sistema | Error: "Email o contraseña incorrectos" |

### 1.3 Recuperar Contraseña
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Solicitar reset | 1. Click "Olvidé mi contraseña" 2. Ingresar email | Mensaje: "Si el email existe, recibirás instrucciones" |

### 1.4 Logout
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Cerrar sesión | Click en avatar > Cerrar sesión | Redirige a /auth |

---

## 2. ROLES Y PERMISOS

### 2.1 Definición de Roles

| Rol | Etiqueta | Descripción |
|-----|----------|-------------|
| **owner** | Propietario | Acceso total, puede editar/eliminar organización |
| **admin** | Administrador | Acceso total excepto eliminar organización |
| **specialist** | Especialista | Gestiona movimientos, cuentas, exporta reportes |
| **operator** | Operador | Solo gestiona movimientos y exporta reportes |
| **viewer** | Veedor | Solo lectura |

### 2.2 Matriz de Permisos

| Acción | owner | admin | specialist | operator | viewer |
|--------|:-----:|:-----:|:----------:|:--------:|:------:|
| Ver dashboard | ✅ | ✅ | ✅ | ✅ | ✅ |
| Ver cuentas | ✅ | ✅ | ✅ | ✅ | ✅ |
| Crear cuentas | ✅ | ✅ | ✅ | ❌ | ❌ |
| Editar cuentas | ✅ | ✅ | ✅ | ❌ | ❌ |
| Eliminar cuentas | ✅ | ✅ | ❌ | ❌ | ❌ |
| Ver transacciones | ✅ | ✅ | ✅ | ✅ | ✅ |
| Crear transacciones | ✅ | ✅ | ✅ | ✅ | ❌ |
| Editar transacciones | ✅ | ✅ | ✅ | ✅ | ❌ |
| Eliminar transacciones | ✅ | ✅ | ✅ | ❌ | ❌ |
| Exportar reportes | ✅ | ✅ | ✅ | ✅ | ✅ |
| Ver equipo | ✅ | ✅ | ✅ | ✅ | ✅ |
| Gestionar equipo | ✅ | ✅ | ❌ | ❌ | ❌ |
| Ver auditoría | ✅ | ✅ | ❌ | ❌ | ❌ |
| Editar organización | ✅ | ❌ | ❌ | ❌ | ❌ |
| Eliminar organización | ✅ | ❌ | ❌ | ❌ | ❌ |
| Crear nueva organización | ✅ | ❌ | ❌ | ❌ | ❌ |

---

## 3. PLANES Y PRECIOS

### 3.1 Planes Personales

| Plan | Precio | Organizaciones | Miembros/Org | Características |
|------|--------|----------------|--------------|-----------------|
| **Personal** | $9/mes | 1 | 1 | Cuentas, movimientos, IA Aike, reportes, CSV/PDF, clientes/proveedores, productos, soporte email |
| **Personal Pro** | $15/mes | 3 | 1 | Todo de Personal + activos, inversiones, auditoría, soporte prioritario |

### 3.2 Planes Empresa (Team)

| Plan | Precio | Organizaciones | Miembros/Org | Características |
|------|--------|----------------|--------------|-----------------|
| **Solo** | $12/mes | 1 | 3 | Cuentas, movimientos, IA Aike, reportes, CSV/PDF, clientes/proveedores, productos, roles y permisos |
| **Team** | $35/mes | 3 | 5 | Todo de Solo + activos, inversiones, auditoría, soporte prioritario |
| **Business** | $65/mes | 5 | 10 | Todo de Team + soporte dedicado |
| **Enterprise** | $120/mes | 15 | 50 | Todo de Business + soporte 24/7, onboarding personalizado |

---

## 4. FUNCIONALIDADES POR SECCIÓN

### 4.1 Dashboard (/)
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Ver balances | Entrar al dashboard | Muestra "Foto" con balances actuales de todas las cuentas |
| Ver estado económico | Click en "Película" | Muestra ingresos vs gastos del período |
| Cambiar período | Seleccionar mes/año diferente | Actualiza gráficos y datos |

### 4.2 Cuentas (/accounts)
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Ver lista cuentas | Navegar a Cuentas | Lista todas las cuentas con balances |
| Crear cuenta | Click "Nueva cuenta" > llenar datos | Cuenta creada |
| Editar cuenta | Click en cuenta > editar nombre/tipo | Cambios guardados |
| Ajustar balance | Click ajuste > ingresar nuevo balance | Balance actualizado, se crea transacción de ajuste |
| Eliminar cuenta | Click eliminar > confirmar | Cuenta eliminada |

**Tipos de cuenta:** Efectivo, Banco, Billetera digital  
**Monedas soportadas:** ARS, USD, USD Efectivo, EUR, BRL, CLP, MXN, COP, PEN, UYU

### 4.3 Transacciones/Movimientos (/transactions)
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Ver movimientos | Navegar a Movimientos | Lista todos los movimientos |
| Filtrar por tipo | Seleccionar Ingreso/Gasto/etc | Solo muestra ese tipo |
| Filtrar por cuenta | Seleccionar cuenta específica | Solo movimientos de esa cuenta |
| Crear ingreso | Click + > tipo Ingreso > llenar datos | Ingreso creado, balance actualizado |
| Crear gasto | Click + > tipo Gasto > llenar datos | Gasto creado, balance actualizado |
| Adjuntar factura | Al crear, subir imagen/PDF | Factura adjuntada al movimiento |
| Editar movimiento | Click en movimiento > editar | Cambios guardados |
| Eliminar movimiento | Click eliminar > confirmar | Movimiento eliminado, balance ajustado |

**Tipos de transacción:**
- Ingreso: Dinero que entra
- Gasto: Dinero que sale
- Cobro pendiente: Dinero por cobrar
- Pago pendiente: Dinero por pagar

### 4.4 Asistente IA - Aike (/ai-assistant)
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Registrar ingreso por texto | Escribir "Vendí un curso a 3000 pesos" | IA detecta tipo, monto, pide cuenta |
| Detectar moneda | Escribir "Gasté 100 dólares" | Solo muestra cuentas en USD |
| Grabación de voz | Click micrófono > hablar | Transcribe y procesa como texto |
| Confirmar transacción | Completar wizard del chat | Transacción creada |

### 4.5 Reportes (/reports)
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Ver resumen | Navegar a Reportes | Muestra ingresos, gastos, balance |
| Exportar CSV | Click "Exportar CSV" | Descarga archivo CSV |
| Exportar PDF | Click "Exportar PDF" | Descarga reporte en PDF |
| Cambiar período | Seleccionar fechas | Actualiza datos del período |

### 4.6 Equipo (/team)
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Ver miembros | Navegar a Equipo | Lista todos los miembros con roles |
| Invitar miembro nuevo | Click "Agregar" > email nuevo > rol | Crea usuario con contraseña temporal |
| Agregar usuario existente | Click "Agregar" > email existente | Agrega al equipo sin crear cuenta |
| Cambiar rol | Click en rol > seleccionar nuevo | Rol actualizado |
| Eliminar miembro | Click eliminar > confirmar | Miembro removido del equipo |

### 4.7 Clientes (/clients)
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Ver clientes | Navegar a Clientes | Lista todos los clientes |
| Crear cliente | Click + > llenar datos | Cliente creado |
| Editar cliente | Click en cliente > editar | Cambios guardados |
| Eliminar cliente | Click eliminar > confirmar | Cliente eliminado |

### 4.8 Proveedores (/suppliers)
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Ver proveedores | Navegar a Proveedores | Lista todos los proveedores |
| Crear proveedor | Click + > llenar datos | Proveedor creado |
| Editar proveedor | Click en proveedor > editar | Cambios guardados |
| Eliminar proveedor | Click eliminar > confirmar | Proveedor eliminado |

### 4.9 Productos (/products)
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Ver productos | Navegar a Productos | Lista todos los productos |
| Crear producto | Click + > nombre, SKU, precio, stock | Producto creado |
| Editar producto | Click en producto > editar | Cambios guardados |
| Ajustar stock | Modificar cantidad | Stock actualizado |

### 4.10 Auditoría (/audit-logs)
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Ver logs | Navegar a Auditoría | Lista cambios recientes |
| Filtrar por tipo | Seleccionar entidad | Solo muestra esa entidad |
| Ver detalle | Click en log | Muestra cambios antes/después |

**Nota:** Solo visible para owner y admin

### 4.11 Configuración (/settings)
| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Editar organización | Cambiar nombre/logo/icono | Cambios guardados |
| Cambiar moneda default | Seleccionar nueva moneda | Moneda actualizada |
| Eliminar organización | Click eliminar > confirmar | Organización eliminada |

**Nota:** Solo visible para owners

---

## 5. CASOS DE PRUEBA POR ROL

### 5.1 Testing como OWNER
1. ✅ Puede crear/editar/eliminar organización
2. ✅ Puede invitar/eliminar miembros
3. ✅ Puede cambiar roles de cualquier miembro
4. ✅ Puede ver auditoría
5. ✅ Todas las funciones de admin/specialist/operator

### 5.2 Testing como ADMIN
1. ✅ Puede gestionar equipo
2. ✅ Puede ver auditoría
3. ❌ NO puede editar/eliminar organización
4. ❌ NO puede crear nuevas organizaciones
5. ✅ Todas las funciones de specialist/operator

### 5.3 Testing como SPECIALIST
1. ✅ Puede crear/editar/eliminar transacciones
2. ✅ Puede crear/editar cuentas
3. ✅ Puede exportar reportes
4. ❌ NO puede eliminar cuentas
5. ❌ NO puede gestionar equipo
6. ❌ NO puede ver auditoría

### 5.4 Testing como OPERATOR
1. ✅ Puede crear/editar transacciones
2. ✅ Puede exportar reportes
3. ❌ NO puede crear/editar cuentas
4. ❌ NO puede eliminar transacciones
5. ❌ NO puede gestionar equipo

### 5.5 Testing como VIEWER
1. ✅ Puede ver dashboard y datos
2. ✅ Puede exportar reportes
3. ❌ NO puede crear nada
4. ❌ NO puede editar nada
5. ❌ NO puede eliminar nada

---

## 6. MULTI-ORGANIZACIÓN

| Caso | Pasos | Resultado Esperado |
|------|-------|-------------------|
| Cambiar organización | Click en selector de org > elegir otra | Cambia contexto, muestra datos de esa org |
| Ver rol en cada org | Observar etiqueta de rol | Muestra el rol del usuario en esa org |
| Crear nueva org | Click "Nueva organización" | Solo disponible para owners |

---

## 7. CONTEXTO PERSONAL vs EMPRESA

| Aspecto | Cuenta Personal | Cuenta Empresa |
|---------|-----------------|----------------|
| Selector de org | Muestra "Mis Finanzas" vs "Equipo X" | Muestra nombre de empresa |
| Sección Equipo | No visible en contexto personal | Visible |
| Sección Reportes | No visible en contexto personal | Visible |
| Clientes/Proveedores | No visible en contexto personal | Visible |

---

## 8. MONEDAS Y TIPOS DE CAMBIO

| Moneda | Código | Símbolo |
|--------|--------|---------|
| Peso Argentino | ARS | $ |
| Dólar (banco) | USD | U$D |
| Dólar efectivo | USD_CASH | U$D |
| Euro | EUR | € |
| Real Brasileño | BRL | R$ |
| Peso Chileno | CLP | $ |
| Peso Mexicano | MXN | $ |
| Peso Colombiano | COP | $ |
| Sol Peruano | PEN | S/ |
| Peso Uruguayo | UYU | $ |

---

## 9. ERRORES COMUNES A VERIFICAR

| Error | Causa | Verificación |
|-------|-------|--------------|
| 401 Unauthorized | Sesión expirada | Redirige a login |
| 403 Forbidden | Sin permisos | Muestra error claro |
| 404 Not Found | Recurso no existe | Muestra error claro |
| Balance negativo | Gasto mayor al saldo | Sistema permite (no bloquea) |

---

## 10. CHECKLIST PRE-PRODUCCIÓN

- [ ] Login/registro funciona
- [ ] Sesiones persisten correctamente
- [ ] Todos los roles tienen permisos correctos
- [ ] Transacciones actualizan balances
- [ ] IA Aike responde correctamente
- [ ] Exportación CSV/PDF funciona
- [ ] Cambio de organización funciona
- [ ] Responsive en mobile
- [ ] Logos/imágenes cargan correctamente

---

*Documento generado para Aikestar v1.0 - Enero 2026*
