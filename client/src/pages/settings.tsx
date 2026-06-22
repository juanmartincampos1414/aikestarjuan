import React, { useState, useEffect } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useUser, useOrganization, useOrganizations, useUpdateUser, useUpdateOrganizationById, useDeleteOrganization, useSwitchOrganization, useMembership, useIsPersonalBasic } from '@/lib/hooks';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import TermsContent from '@/components/TermsContent';
import PrivacyContent from '@/components/PrivacyContent';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { User, Building, Save, Pencil, Trash2, Check, X, AlertTriangle, AlertCircle, HelpCircle, Shield, Lock, Eye, EyeOff, FileText, KeyRound, CreditCard, ArrowLeftRight, ArrowRight, Users, Truck, Package, BarChart3, Sparkles, UserPlus, Settings, Send, MessageCircle, CheckCircle, Tags, Plus, TrendingUp, TrendingDown, Clock, RefreshCw, Mail, Headphones, Repeat, Smartphone, LayoutDashboard, CalendarClock, Calendar, BookOpen, Warehouse, HeartPulse, Download, Bell, ClipboardList, Crown, History, FolderArchive, RotateCcw, Store } from 'lucide-react';
import TeamPage from './team';
import AuditLogsPage from './audit-logs';
import CountryPhoneInput from '@/components/CountryPhoneInput';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { PLAN_DETAILS, PLAN_LABELS, PLAN_TYPES, ROLE_LABELS, type PlanType, type Role } from '@shared/schema';
import { BackButton } from '@/components/BackButton';
import { OrganizationBrandPicker, getIconByKey } from '@/components/OrganizationBrandPicker';
import TaxProfileSection from '@/components/TaxProfileSection';
import FacturadorSection from '@/components/FacturadorSection';
import ProfitabilityCodesSection from '@/components/ProfitabilityCodesSection';
import PaymentMethodsSection from '@/components/PaymentMethodsSection';
import { UserProfilePicker, getProfileIconByKey } from '@/components/UserProfilePicker';
import { fetchWithAuth, categoryAPI } from '@/lib/api';
import { TiendanubeIntegration } from '@/components/integrations/TiendanubeIntegration';
import { FEATURE_FLAGS } from '@/lib/constants';

const userProfileSchema = z.object({
  name: z.string().min(2, 'El nombre es requerido'),
  email: z.string().email('Email inválido'),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Ingresá tu contraseña actual'),
  newPassword: z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres'),
  confirmPassword: z.string().min(1, 'Confirmá tu nueva contraseña'),
}).refine(data => data.newPassword === data.confirmPassword, {
  message: 'Las contraseñas no coinciden',
  path: ['confirmPassword'],
});

const firstLoginSchema = z.object({
  name: z.string().min(2, 'El nombre es requerido'),
  newPassword: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres'),
  confirmPassword: z.string().min(1, 'Confirmá tu nueva contraseña'),
}).refine(data => data.newPassword === data.confirmPassword, {
  message: 'Las contraseñas no coinciden',
  path: ['confirmPassword'],
});

type UserProfileFormValues = z.infer<typeof userProfileSchema>;
type PasswordFormValues = z.infer<typeof passwordSchema>;
type FirstLoginFormValues = z.infer<typeof firstLoginSchema>;

// Single source of truth for the bot's WhatsApp number on the frontend.
// Backend authoritative version lives in `getBotPhoneInfo()` (server/routes/whatsapp.ts)
// and is exposed via GET /api/whatsapp/bot-info, which the linking wizard
// fetches at runtime. These constants are the conservative fallback used
// for FAQ copy and the wa.me deeplink before the API responds — both must
// be updated together if our production WhatsApp Business number ever
// changes (and the backend constant must be updated too).
const BOT_DISPLAY_FALLBACK = '+54 11 2489-4944';
const BOT_WAME_FALLBACK = '5491124894944';

const FAQ_CATEGORIES = [
  {
    category: 'Cuentas',
    icon: 'CreditCard',
    items: [
      { question: '¿Cómo agrego una nueva cuenta?', answer: 'Ve a "Cuentas" en el menú lateral y hacé clic en "Nueva Cuenta". Elegí el tipo (banco, efectivo, billetera) y la moneda.' },
      { question: '¿Qué tipos de cuentas puedo crear?', answer: 'Podés crear cuentas bancarias, cajas de efectivo y billeteras digitales (Mercado Pago, PayPal, etc.).' },
      { question: '¿Cómo edito el saldo inicial de una cuenta?', answer: 'Desde la lista de cuentas, hacé clic en el ícono de lápiz junto a la cuenta y modificá el saldo inicial.' },
      { question: '¿Puedo eliminar una cuenta?', answer: 'Sí, pero solo si no tiene movimientos asociados. Primero debés eliminar o transferir los movimientos.' },
      { question: '¿Qué monedas soporta Aikestar?', answer: 'Soportamos Pesos Argentinos (ARS), Dólares (USD), Dólares efectivo (USD_CASH) y Euros (EUR).' },
    ]
  },
  {
    category: 'Movimientos',
    icon: 'ArrowLeftRight',
    items: [
      { question: '¿Cómo registro un ingreso o egreso?', answer: 'Desde "Movimientos", hacé clic en "+ Nuevo" y elegí el tipo. Completá monto, concepto y cuenta.' },
      { question: '¿El concepto es obligatorio?', answer: 'Sí, al registrar un movimiento debés seleccionar o escribir un concepto (categoría). Esto permite clasificar correctamente cada operación y mejorar tus reportes.' },
      { question: '¿Qué es un movimiento "A Cobrar"?', answer: 'Es una cuenta por cobrar: registra dinero que te deben. Cuando te paguen, marcalo como cobrado.' },
      { question: '¿Qué es un movimiento "A Pagar"?', answer: 'Es una cuenta por pagar: registra dinero que debés. Cuando pagues, marcalo como pagado.' },
      { question: '¿Cómo adjunto un comprobante?', answer: 'Al crear o editar un movimiento, usá el botón "Adjuntar" para subir una imagen o PDF del comprobante.' },
      { question: '¿Cómo filtro los movimientos?', answer: 'Usá los filtros de fecha, tipo, cuenta o estado en la parte superior de la lista de movimientos.' },
    ]
  },
  {
    category: 'Transferencias entre Cuentas',
    icon: 'Repeat',
    items: [
      { question: '¿Cómo hago una transferencia entre cuentas?', answer: 'Desde "Movimientos", hacé clic en "+ Nuevo" y elegí "Transferencia". Seleccioná la cuenta de origen, la cuenta de destino, ingresá el monto y una descripción opcional.' },
      { question: '¿Puedo transferir entre cuentas de diferente moneda?', answer: 'Sí. Al seleccionar cuentas con distinta moneda (ej: ARS a USD), el sistema aplica automáticamente el tipo de cambio del día. Podés ver y editar el tipo de cambio antes de confirmar.' },
      { question: '¿De dónde sale el tipo de cambio?', answer: 'Usamos la cotización del Dólar Blue actualizada en tiempo real. Siempre se muestra como "1 USD = X ARS" o "1 EUR = X ARS" para mayor claridad.' },
      { question: '¿Puedo usar un tipo de cambio diferente?', answer: 'Sí. En la pantalla de transferencia podés editar manualmente el tipo de cambio si tu operación fue a una cotización distinta.' },
      { question: '¿Cómo veo el resumen antes de confirmar?', answer: 'Antes de confirmar, verás un resumen con: cuenta origen, cuenta destino, monto a transferir, tipo de cambio (si aplica), y los saldos antes y después de la operación.' },
      { question: '¿La transferencia afecta mi balance total?', answer: 'No. Las transferencias mueven dinero entre tus cuentas pero no cambian tu patrimonio total. Es simplemente un movimiento interno.' },
      { question: '¿Dónde veo mis transferencias?', answer: 'En "Movimientos" aparecen con un ícono morado de flechas. Podés filtrar por tipo "Transferencia" para verlas todas juntas.' },
    ]
  },
  {
    category: 'Clientes',
    icon: 'Users',
    items: [
      { question: '¿Cómo agrego un cliente?', answer: 'Ve a "Oficina" > "Clientes" y hacé clic en "+ Nuevo Cliente". Completá nombre, email y teléfono.' },
      { question: '¿Puedo ver el historial de un cliente?', answer: 'Sí, al hacer clic en un cliente podés ver todos sus movimientos y saldo pendiente.' },
      { question: '¿Cómo asocio un movimiento a un cliente?', answer: 'Al crear un movimiento, seleccioná el cliente en el campo correspondiente.' },
    ]
  },
  {
    category: 'Proveedores',
    icon: 'Truck',
    items: [
      { question: '¿Cómo agrego un proveedor?', answer: 'Ve a "Oficina" > "Proveedores" y hacé clic en "+ Nuevo Proveedor". Completá los datos de contacto.' },
      { question: '¿Puedo ver cuánto le debo a un proveedor?', answer: 'Sí, en el detalle del proveedor podés ver el total de cuentas por pagar pendientes.' },
    ]
  },
  {
    category: 'Productos',
    icon: 'Package',
    items: [
      { question: '¿Cómo registro un producto?', answer: 'Ve a "Oficina" > "Productos" y hacé clic en "+ Nuevo Producto". Agregá nombre, SKU, precio y stock.' },
      { question: '¿Cómo actualizo el stock?', answer: 'Podés editar el stock manualmente o se actualiza automáticamente al registrar ventas/compras.' },
      { question: '¿Puedo establecer precios en diferentes monedas?', answer: 'Sí, cada producto puede tener precio en la moneda que prefieras.' },
    ]
  },
  {
    category: 'Reportes',
    icon: 'BarChart3',
    items: [
      { question: '¿Cómo genero un reporte?', answer: 'Ve a "Reportes", seleccioná el período y tipo de informe. Podés exportar a CSV o PDF.' },
      { question: '¿Qué es el Estado de Resultados?', answer: 'Muestra tus ingresos menos egresos en un período, indicando si tuviste ganancia o pérdida.' },
      { question: '¿Qué significa la valuación de la empresa?', answer: 'Es una estimación del valor de tu negocio basada en EBITDA, activos e inversiones.' },
      { question: '¿Puedo ver gráficos de evolución?', answer: 'Sí, en reportes podés ver gráficos de ingresos, egresos y flujo de caja por período.' },
    ]
  },
  {
    category: 'Aike (IA)',
    icon: 'Sparkles',
    items: [
      { question: '¿Cómo uso el asistente Aike?', answer: 'Hacé clic en el botón de Aike (esquina inferior) y describí tu operación en lenguaje natural.' },
      { question: '¿Qué puede hacer Aike?', answer: 'Puede registrar movimientos, analizar tu salud financiera, extraer datos de comprobantes y más.' },
      { question: '¿Aike puede leer mis comprobantes?', answer: 'Sí, podés subir imágenes o PDFs de facturas y Aike extrae los datos automáticamente.' },
      { question: '¿Aike aprende de mis datos?', answer: 'Aike usa tus datos solo para asistirte. No comparte ni entrena modelos con tu información.' },
    ]
  },
  {
    category: 'Equipo y Permisos',
    icon: 'UserPlus',
    items: [
      { question: '¿Cómo invito a un colaborador?', answer: 'Ve a "Equipo" y hacé clic en "Invitar Miembro". Ingresá su email y asigná un rol.' },
      { question: '¿Qué roles existen?', answer: 'Hay 5 roles: Propietario (vos, control absoluto y facturación), Administrador (configura todo y gestiona miembros, no toca el plan), Especialista (crea, edita y elimina movimientos y cuentas), Operador (carga y edita movimientos pero no los elimina) y Veedor (solo lectura). Mirá la guía visual completa dentro de "Equipo".' },
      { question: 'Un miembro recibe "No tenés permiso", ¿qué hago?', answer: 'Significa que su rol no autoriza esa acción. Como Propietario o Administrador podés cambiarle el rol desde Configuración → Equipo. Por ejemplo, si querés que pueda eliminar movimientos, asignale Especialista o superior.' },
      { question: '¿Puedo cambiar el rol de un miembro?', answer: 'Sí, desde la lista de equipo podés editar el rol de cualquier miembro excepto el dueño.' },
    ]
  },
  {
    category: 'Configuración',
    icon: 'Settings',
    items: [
      { question: '¿Cómo cambio mi contraseña?', answer: 'Ve a "Ajustes" > "Mi Perfil" y usá el formulario de cambio de contraseña.' },
      { question: '¿Cómo configuro los tipos de cambio?', answer: 'En el dashboard, hacé clic en "Tipos de Cambio" para editar las cotizaciones USD y EUR.' },
      { question: '¿Puedo tener varias organizaciones?', answer: 'Sí, podés tener hasta 3 organizaciones. Cada una tiene sus propios datos separados.' },
      { question: '¿Cómo cambio el logo de mi organización?', answer: 'Ve a "Ajustes" > "Mis Organizaciones" y hacé clic en el ícono de la organización para cambiarlo.' },
      { question: '¿Cómo elimino mi cuenta?', answer: 'En "Ajustes" > "Mi Perfil", al final encontrarás la opción para eliminar tu cuenta permanentemente.' },
    ]
  },
  {
    category: 'Costos y Gastos',
    icon: 'Tags',
    items: [
      { question: '¿Qué diferencia hay entre Costo y Gasto?', answer: 'Un Costo está directamente relacionado con la producción o adquisición de lo que vendés (proveedores, insumos, transporte, materiales). Un Gasto es operativo o administrativo (alquiler, sueldos, servicios, marketing).' },
      { question: '¿Cómo configuro una categoría como Costo o Gasto?', answer: 'En "Ajustes" > "Categorías", cada categoría de egreso tiene un toggle para elegir si es Costo (naranja) o Gasto (violeta). Podés cambiarlo en cualquier momento.' },
      { question: '¿Puedo aplicar el cambio a movimientos anteriores?', answer: 'Sí. Al cambiar el tipo de una categoría, aparece un diálogo con dos opciones: aplicar solo a nuevos movimientos, o aplicar a todas las transacciones existentes de esa categoría.' },
      { question: '¿Dónde veo la separación en los reportes?', answer: 'En "Reportes", el gráfico de Evolución de Caja muestra barras separadas para Costos (naranja) y Gastos (violeta). En la pestaña Económica, el P&L muestra Ventas, Costos, Gastos, Margen Bruto y Resultado.' },
      { question: '¿Qué es el Margen Bruto?', answer: 'Es la diferencia entre tus Ventas y tus Costos. Indica cuánto ganás antes de descontar los gastos operativos. Margen Bruto = Ventas - Costos.' },
      { question: '¿Qué categorías son Costo por defecto?', answer: 'Proveedores, Insumos, Transporte, Materiales, Producción e Inventario se configuran como Costo automáticamente. Las demás categorías de egreso se consideran Gasto.' },
    ]
  },
  {
    category: 'WhatsApp',
    icon: 'MessageCircle',
    items: [
      { question: '¿Cómo uso WhatsApp con Aikestar?', answer: `Andá a "Ajustes" > "WhatsApp" y tocá "Vincular número". Primero te vamos a pedir que abras WhatsApp y le mandes "Hola" al ${BOT_DISPLAY_FALLBACK} — esto es obligatorio porque WhatsApp solo deja al bot responderte si vos le escribiste antes. Después ingresás tu número, recibís un código de 6 dígitos por WhatsApp y lo pegás en la app.` },
      { question: '¿Por qué tengo que escribirle "Hola" al bot antes de vincular?', answer: 'WhatsApp Business no permite que un bot le mande mensajes a alguien que nunca le escribió. Si saltás ese paso, el código que te enviemos para verificarte no te va a llegar nunca. Por eso el primer paso de la vinculación es siempre saludar al bot.' },
      { question: '¿A qué número debo escribir?', answer: `Escribí a ${BOT_DISPLAY_FALLBACK} desde WhatsApp. Asegurate de que sea el mismo número que vinculaste en la app.` },
      { question: 'No me llega el código de verificación, ¿qué hago?', answer: `Casi siempre es porque todavía no le escribiste al bot desde el número que estás vinculando, o le escribiste desde otro celular. Abrí WhatsApp en el teléfono cuyo número estás vinculando, mandale "Hola" al ${BOT_DISPLAY_FALLBACK}, y volvé a la app a tocar "Reenviar código".` },
      { question: '¿Qué puedo hacer por WhatsApp?', answer: 'Podés registrar ingresos, egresos, cuentas por cobrar y por pagar escribiendo en lenguaje natural. Ej: "gasté 5000 en almuerzo" o "cobré 10000 de Juan".' },
      { question: '¿Puedo consultar mis finanzas?', answer: 'Sí, podés preguntar: "cuánto gasté este mes", "mi saldo", "salud financiera", "resumen del mes", etc.' },
      { question: '¿Puedo cambiar de organización?', answer: 'Sí, escribí "cambiar a [nombre de organización]" o "mis organizaciones" para ver la lista.' },
      { question: '¿Puedo adjuntar comprobantes?', answer: 'Sí, podés enviar una imagen de la factura cuando Aike te pregunte y se guardará junto al movimiento.' },
      { question: '¿Qué NO puedo hacer por WhatsApp?', answer: 'Por seguridad, no podés crear cuentas bancarias, clientes, proveedores, productos ni otras entidades. Eso se hace desde la app web que es más seguro y tiene más opciones.' },
      { question: '¿Por qué algunos datos debo ingresarlos en la web?', answer: 'La app web ofrece más seguridad, validaciones y opciones completas para configurar tu negocio. WhatsApp es ideal para el día a día: registrar movimientos rápidamente.' },
      { question: '¿Es seguro usar WhatsApp?', answer: 'Sí, tu número está vinculado a tu cuenta y Aike verifica tu identidad antes de procesar cualquier operación. Además, el chat usa cifrado de extremo a extremo de WhatsApp.' },
    ]
  },
  {
    category: 'Inversiones',
    icon: 'TrendingUp',
    items: [
      { question: '¿Cómo registro una cuenta de inversión?', answer: 'En "Cuentas", creá una nueva cuenta y elegí el tipo: inversión, broker, cripto, fintech o plazo fijo. Podés cargar el monto invertido, la tasa de interés y la fecha de vencimiento.' },
      { question: '¿Qué es el rendimiento de una inversión?', answer: 'Es la ganancia acumulada según la tasa de interés y el tiempo transcurrido. Se calcula automáticamente y lo podés ver en el detalle de la cuenta.' },
      { question: '¿Cómo veo cuánto falta para el vencimiento?', answer: 'En la lista de cuentas de inversión aparece una cuenta regresiva con los días restantes hasta la fecha de vencimiento.' },
      { question: '¿Qué tipos de inversión puedo registrar?', answer: 'Podés registrar plazos fijos, brokers, criptomonedas, cuentas fintech y cualquier inversión financiera con su tasa y vencimiento.' },
    ]
  },
  {
    category: 'Movimientos Recurrentes',
    icon: 'CalendarClock',
    items: [
      { question: '¿Qué es un movimiento recurrente?', answer: 'Es un movimiento que se repite automáticamente con una frecuencia definida (semanal, quincenal, mensual, bimestral, trimestral, semestral o anual). Ideal para alquileres, sueldos, servicios fijos, etc.' },
      { question: '¿Cómo creo un movimiento recurrente?', answer: 'Al crear un movimiento, activá la opción "¿Es recurrente?" y elegí la frecuencia. Después de confirmar el primero, el sistema genera automáticamente el siguiente.' },
      { question: '¿Puedo cancelar una recurrencia?', answer: 'Sí, al eliminar un movimiento recurrente también se elimina la próxima instancia programada. Los movimientos anteriores ya confirmados no se modifican.' },
      { question: '¿Los recurrentes se generan solos?', answer: 'Sí, cada vez que aprobás o completás un movimiento recurrente, el sistema crea automáticamente el siguiente con la fecha correspondiente.' },
    ]
  },
  {
    category: 'Calendario',
    icon: 'Calendar',
    items: [
      { question: '¿Qué muestra el calendario?', answer: 'Muestra todos tus movimientos organizados por fecha: ingresos, egresos, cuentas por cobrar y por pagar. Los pendientes se marcan con un ícono de reloj.' },
      { question: '¿Qué vistas tiene el calendario?', answer: 'Podés ver por día, semana, mes o año. Cada vista muestra los totales de ingresos y egresos del período.' },
      { question: '¿Cómo veo los vencimientos próximos?', answer: 'En la vista mensual o semanal, los movimientos pendientes (a cobrar/pagar) aparecen destacados con su fecha de vencimiento.' },
      { question: '¿Puedo crear movimientos desde el calendario?', answer: 'Podés ver los detalles de cada movimiento haciendo clic en él. Para crear nuevos, usá el botón "+ Nuevo" del menú principal.' },
    ]
  },
  {
    category: 'Cuenta Corriente',
    icon: 'BookOpen',
    items: [
      { question: '¿Qué es la Cuenta Corriente?', answer: 'Es el resumen de todas las operaciones con un cliente o proveedor. Muestra el Debe (lo que te deben o debés), el Haber (lo que pagaron o pagaste) y el Saldo Final.' },
      { question: '¿Cómo veo la cuenta corriente de un cliente?', answer: 'Entrá a "Oficina" > "Clientes", hacé clic en el cliente y verás su historial completo con el saldo actual.' },
      { question: '¿Puedo exportar la cuenta corriente?', answer: 'Sí, podés exportar la cuenta corriente de cualquier cliente o proveedor en formato CSV o PDF desde el detalle de cada uno.' },
      { question: '¿Las cancelaciones aparecen en la cuenta corriente?', answer: 'Sí, si cancelás un movimiento completado, aparece como "Cancelado" en la cuenta corriente del cliente o proveedor correspondiente.' },
    ]
  },
  {
    category: 'Stock e Inventario',
    icon: 'Warehouse',
    items: [
      { question: '¿Cómo funciona el stock automático?', answer: 'Cuando registrás un egreso o cuenta a pagar con un producto, el stock sube (entrada). Cuando registrás un ingreso o cuenta a cobrar, el stock baja (salida). Todo se actualiza automáticamente al completar el movimiento.' },
      { question: '¿Puedo ajustar el stock manualmente?', answer: 'Sí, desde "Oficina" > "Productos", elegí un producto y usá el botón de movimiento de stock para registrar entradas, salidas o ajustes manuales.' },
      { question: '¿Qué pasa con el stock si cancelo un movimiento?', answer: 'Se revierte automáticamente. Si habías dado entrada a 10 unidades, la cancelación las resta. Todo queda registrado en el historial de movimientos de stock.' },
      { question: '¿Qué es el stock mínimo?', answer: 'Es el nivel de alerta que configurás para cada producto. Te ayuda a saber cuándo necesitás reponer mercadería.' },
      { question: '¿Puedo crear un producto desde un movimiento?', answer: 'Sí, al registrar un movimiento podés hacer clic en "Agregar producto" en el selector de productos. Se abre un formulario completo con todos los campos: tipo, precios, stock, unidad, etc.' },
      { question: '¿Qué tipos de producto existen?', answer: 'Hay tres tipos: Producto (mercadería física con stock), Servicio (sin stock, como consultoría o diseño) y Activo (bienes de uso como maquinaria o computadoras, con depreciación).' },
    ]
  },
  {
    category: 'Dashboard',
    icon: 'LayoutDashboard',
    items: [
      { question: '¿Qué es la vista "Foto"?', answer: 'Es una foto instantánea de tu situación actual: muestra los saldos de todas tus cuentas, cuánto te deben, cuánto debés y tu patrimonio total.' },
      { question: '¿Qué es la vista "Película"?', answer: 'Es la película de tu mes: muestra el flujo económico del período actual, comparando ingresos vs egresos y la variación respecto al mes anterior.' },
      { question: '¿Qué significan las variaciones porcentuales?', answer: 'Indican cuánto subieron o bajaron tus ingresos y egresos comparados con el mes anterior. Verde significa mejora, rojo significa que empeoró.' },
      { question: '¿Qué son los costos fijos?', answer: 'Son los movimientos marcados como recurrentes. El dashboard los suma para mostrarte cuánto gastás regularmente cada mes.' },
    ]
  },
  {
    category: 'Salud Financiera',
    icon: 'HeartPulse',
    items: [
      { question: '¿Qué es el puntaje de salud financiera?', answer: 'Es un indicador de 0 a 100 que evalúa tu situación económica. Considera liquidez (si tenés plata disponible), posición neta (ingresos vs egresos), cobertura de deuda y urgencia de pagos.' },
      { question: '¿Cómo se calcula?', answer: 'Analiza tus saldos, ingresos, egresos y compromisos pendientes. Si tenés más ingresos que egresos y pocas deudas vencidas, el puntaje será alto.' },
      { question: '¿Qué significa cada color?', answer: 'Verde (80-100): excelente. Amarillo (60-79): buena. Naranja (40-59): necesita atención. Rojo (0-39): situación crítica.' },
      { question: '¿Puedo pedir un análisis con IA?', answer: 'Sí, desde el dashboard podés pedir a Aike un análisis detallado de tu salud financiera con recomendaciones personalizadas.' },
    ]
  },
  {
    category: 'Exportar Datos',
    icon: 'Download',
    items: [
      { question: '¿Qué puedo exportar?', answer: 'Podés exportar reportes financieros, estados de resultados, cuentas corrientes de clientes y proveedores, listados de productos y movimientos.' },
      { question: '¿En qué formatos puedo exportar?', answer: 'CSV (para abrir en Excel o Google Sheets) y PDF (para imprimir o compartir).' },
      { question: '¿Cómo exporto un reporte?', answer: 'Ve a "Reportes", seleccioná el período y tipo de informe, y usá los botones de CSV o PDF en la parte superior del reporte.' },
      { question: '¿Puedo exportar la cuenta corriente de un cliente?', answer: 'Sí, entrá al detalle del cliente o proveedor y usá los botones de exportación para descargar su cuenta corriente en CSV o PDF.' },
    ]
  },
  {
    category: 'Notificaciones',
    icon: 'Bell',
    items: [
      { question: '¿Qué notificaciones recibo?', answer: 'Recibís alertas de compromisos próximos a vencer (dentro de 5 días) y vencidos. También notificaciones de acciones importantes del equipo.' },
      { question: '¿Dónde veo mis notificaciones?', answer: 'Hacé clic en el ícono de campana en la barra superior. Tiene dos secciones: "Pendientes" (activas) e "Historial" (anteriores).' },
      { question: '¿Las notificaciones se generan automáticamente?', answer: 'Sí, un proceso diario revisa tus compromisos y genera alertas para los que están por vencer o ya vencieron.' },
      { question: '¿Recibo emails de resumen?', answer: 'Sí, los lunes a las 6 AM recibís un resumen semanal por email con tu salud financiera, compromisos pendientes e ingresos/egresos de la semana.' },
    ]
  },
  {
    category: 'Auditoría',
    icon: 'ClipboardList',
    items: [
      { question: '¿Qué es el registro de auditoría?', answer: 'Es un historial detallado de todos los cambios realizados en tu organización: quién creó, editó o eliminó cuentas, movimientos, clientes, productos, etc.' },
      { question: '¿Quién puede ver la auditoría?', answer: 'Solo los administradores y dueños de la organización tienen acceso al registro de auditoría.' },
      { question: '¿Para qué sirve?', answer: 'Te permite rastrear exactamente quién hizo cada cambio y cuándo, útil para detectar errores o verificar que tu equipo trabaja correctamente.' },
    ]
  },
  {
    category: 'Suscripción y Planes',
    icon: 'Crown',
    items: [
      { question: '¿Qué planes hay disponibles?', answer: 'Hay planes Personal, Solo, Team, Business y Enterprise. Cada uno tiene diferentes límites de organizaciones, miembros y funcionalidades.' },
      { question: '¿Cómo cambio mi plan?', answer: 'Ve a "Ajustes" > "Mi suscripción". Desde ahí podés ver tu plan actual y acceder al portal de Stripe para cambiar o actualizar.' },
      { question: '¿Puedo cancelar mi suscripción?', answer: 'Sí, desde "Ajustes" podés cancelar. Tu acceso se mantiene hasta el final del período ya pagado.' },
      { question: '¿Qué pasa si cancelo?', answer: 'Seguís teniendo acceso hasta que termine tu período. Después, tu cuenta queda inactiva pero tus datos se conservan por si querés reactivar.' },
      { question: '¿Puedo reactivar después de cancelar?', answer: 'Sí, mientras el período no haya terminado podés reactivar la suscripción desde "Ajustes" sin perder ningún dato.' },
    ]
  },
];

interface WhatsappPreferencesResponse {
  autoAssignedDefault?: boolean;
}

function isWhatsappPreferencesResponse(value: unknown): value is WhatsappPreferencesResponse {
  return typeof value === 'object' && value !== null;
}

export default function SettingsPage() {
  const { data: user } = useUser();
  const { data: organization } = useOrganization();
  const { data: organizations = [] } = useOrganizations();
  const { data: membership } = useMembership();
  const updateUserMutation = useUpdateUser();
  
  const { data: planLimits } = useQuery<{
    planType: string;
    planLabel: string;
    limits: { maxOrgs: number; maxMembersPerOrg: number };
    usage: { organizations: number; members: number };
    isTeamPlan: boolean;
  }>({
    queryKey: ["/subscription/limits"],
    queryFn: () => fetchWithAuth("/subscription/limits"),
  });

  const { data: subscriptionStatus, refetch: refetchSubscriptionStatus } = useQuery<{
    hasSubscription: boolean;
    planType?: string;
    planLabel?: string;
    status?: string;
    cancellationStatus: string | null;
    cancelAtPeriodEnd: boolean;
    accessEndsAt: string | null;
    cancellationRequestedAt: string | null;
    hasLocalSubscription?: boolean;
    hasStripeSubscriptionId?: boolean;
    stripeSubscriptionValid?: boolean;
    stripeLiveMode?: boolean;
    localPlanType?: string | null;
    needsSync?: boolean;
    stripeStatus?: any;
    isTrialing?: boolean;
    trialEndsAt?: string | null;
    trialDaysRemaining?: number | null;
  }>({
    queryKey: ["/subscription/status"],
    queryFn: () => fetchWithAuth("/subscription/status"),
  });

  const [paymentHistoryOpen, setPaymentHistoryOpen] = useState(false);
  const [paymentHistoryMaximized, setPaymentHistoryMaximized] = useState(false);

  type PaymentHistoryItem = {
    id: string;
    number: string | null;
    created: number;
    amount: number;
    currency: string;
    status: string | null;
    description: string | null;
    card: { brand: string | null; last4: string | null } | null;
    invoicePdf: string | null;
    hostedInvoiceUrl: string | null;
  };

  const {
    data: paymentHistoryData,
    isLoading: isLoadingPaymentHistory,
    isError: isPaymentHistoryError,
    refetch: refetchPaymentHistory,
  } = useQuery<{ payments: PaymentHistoryItem[]; hasMore?: boolean }>({
    queryKey: ['/stripe/payment-history'],
    queryFn: () => fetchWithAuth('/stripe/payment-history'),
    enabled: paymentHistoryOpen,
    staleTime: 60_000,
  });

  // Páginas extra cargadas con "Cargar más antiguos".
  const [olderPayments, setOlderPayments] = useState<PaymentHistoryItem[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [isLoadingOlderPayments, setIsLoadingOlderPayments] = useState(false);
  const [olderPaymentsError, setOlderPaymentsError] = useState(false);

  // Resetear el estado de las páginas extra al abrir/cerrar el diálogo o al
  // recargar la primera página, para no mezclar resultados viejos.
  useEffect(() => {
    if (!paymentHistoryOpen) {
      setOlderPayments([]);
      setOlderHasMore(null);
      setIsLoadingOlderPayments(false);
      setOlderPaymentsError(false);
    }
  }, [paymentHistoryOpen]);

  const combinedPayments: PaymentHistoryItem[] = paymentHistoryData
    ? [...paymentHistoryData.payments, ...olderPayments]
    : [];
  const canLoadMorePayments = olderHasMore === null
    ? Boolean(paymentHistoryData?.hasMore)
    : olderHasMore;

  const handleLoadMorePayments = async () => {
    if (isLoadingOlderPayments) return;
    const lastId = combinedPayments[combinedPayments.length - 1]?.id;
    if (!lastId) return;
    setIsLoadingOlderPayments(true);
    setOlderPaymentsError(false);
    try {
      const resp = await fetchWithAuth(
        `/stripe/payment-history?starting_after=${encodeURIComponent(lastId)}`
      ) as { payments: PaymentHistoryItem[]; hasMore?: boolean };
      setOlderPayments((prev) => [...prev, ...(resp.payments || [])]);
      setOlderHasMore(Boolean(resp.hasMore));
    } catch (err) {
      setOlderPaymentsError(true);
    } finally {
      setIsLoadingOlderPayments(false);
    }
  };

  const [isResumingSubscription, setIsResumingSubscription] = useState(false);

  const handleResumeSubscription = async () => {
    try {
      setIsResumingSubscription(true);
      await fetchWithAuth('/subscription/resume', {
        method: 'POST',
      });
      
      queryClient.invalidateQueries({ queryKey: ['/subscription/limits'] });
      queryClient.invalidateQueries({ queryKey: ['/subscription/status'] });
      
      toast({
        title: "Suscripción reactivada",
        description: "Tu suscripción ha sido reactivada. No se eliminarán tus datos.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo reactivar la suscripción",
        variant: "destructive",
      });
    } finally {
      setIsResumingSubscription(false);
    }
  };

  const isPendingCancellation = subscriptionStatus?.cancellationStatus === 'pending_cancellation';
  const accessEndsAtFormatted = subscriptionStatus?.accessEndsAt 
    ? new Date(subscriptionStatus.accessEndsAt).toLocaleDateString('es-AR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      })
    : null;

  const [isSyncingSubscription, setIsSyncingSubscription] = useState(false);

  const atOrgLimit = planLimits && planLimits.usage.organizations >= planLimits.limits.maxOrgs;
  const updateOrgMutation = useUpdateOrganizationById();
  const deleteOrgMutation = useDeleteOrganization();
  const switchOrgMutation = useSwitchOrganization();
  const { toast } = useToast();

  const [editingOrgId, setEditingOrgId] = useState<string | null>(null);
  const [editingOrgName, setEditingOrgName] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [orgToDelete, setOrgToDelete] = useState<{ id: string; name: string } | null>(null);
  const [brandPickerOpen, setBrandPickerOpen] = useState(false);
  const [brandPickerOrg, setBrandPickerOrg] = useState<{ id: string; logoUrl?: string | null; iconKey?: string | null; contactEmail?: string | null; contactPhone?: string | null } | null>(null);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isEditingPhone, setIsEditingPhone] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isSavingPhone, setIsSavingPhone] = useState(false);
  const [isDeletingPhone, setIsDeletingPhone] = useState(false);
  // 3-step wizard: greet bot first → enter phone → enter code.
  const [phoneStep, setPhoneStep] = useState<'greet-bot' | 'enter-phone' | 'enter-code'>('greet-bot');
  const [verificationCode, setVerificationCode] = useState('');
  const [pendingPhone, setPendingPhone] = useState<string | null>(null);
  const [pendingDisplayPhone, setPendingDisplayPhone] = useState<string | null>(null);
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const [resendCooldownSec, setResendCooldownSec] = useState(0);
  // Becomes true once the user clicks the "Open WhatsApp" CTA OR ticks the
  // "Already messaged the bot" checkbox. The "Continue" button on step 1
  // stays disabled until this is true so we don't move on prematurely.
  const [botGreeted, setBotGreeted] = useState(false);
  // After ~30s on step 3 with no successful verify, surface a hint that the
  // most likely cause is "user never opened the conversation with the bot",
  // with a one-tap link back to wa.me. Resets every time we (re)enter step 3.
  const [showNotReceivedHint, setShowNotReceivedHint] = useState(false);
  // Bot WhatsApp number metadata (display, wa.me digits, suggested greeting).
  // Hydrated from the public /api/whatsapp/bot-info endpoint so the linking
  // wizard always shows the same number the backend would actually message.
  const [botInfo, setBotInfo] = useState<{ e164: string; waMe: string; display: string; defaultGreeting: string } | null>(null);

  useEffect(() => {
    if (resendCooldownSec <= 0) return;
    const t = setTimeout(() => setResendCooldownSec((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [resendCooldownSec]);

  // Hydrate the bot number on mount so wizard + FAQ share one source.
  useEffect(() => {
    if (botInfo) return;
    fetch('/api/whatsapp/bot-info', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.e164) setBotInfo(data);
      })
      .catch(() => { /* non-fatal: UI falls back to constants */ });
  }, [botInfo]);

  // 30-second "no me llegó" hint timer; armed on the code-entry step.
  useEffect(() => {
    if (phoneStep !== 'enter-code') {
      setShowNotReceivedHint(false);
      return;
    }
    setShowNotReceivedHint(false);
    const t = setTimeout(() => setShowNotReceivedHint(true), 30_000);
    return () => clearTimeout(t);
  }, [phoneStep, pendingPhone]);

  const botDisplayNumber = botInfo?.display ?? BOT_DISPLAY_FALLBACK;
  const botWaLink = botInfo
    ? `https://wa.me/${botInfo.waMe}?text=${encodeURIComponent(botInfo.defaultGreeting || 'Hola Aike')}`
    : `https://wa.me/${BOT_WAME_FALLBACK}?text=${encodeURIComponent('Hola Aike')}`;
  const handleOpenWhatsappBot = () => {
    setBotGreeted(true);
    window.open(botWaLink, '_blank', 'noopener,noreferrer');
  };
  const [deleteAccountDialogOpen, setDeleteAccountDialogOpen] = useState(false);
  const [deleteAccountPassword, setDeleteAccountPassword] = useState('');
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [helpQuestion, setHelpQuestion] = useState('');
  const [helpAnswer, setHelpAnswer] = useState('');
  const [isAskingHelp, setIsAskingHelp] = useState(false);
  const [supportSubject, setSupportSubject] = useState('');
  const [supportMessage, setSupportMessage] = useState('');
  const [supportContactEmail, setSupportContactEmail] = useState('');
  const [isSendingSupport, setIsSendingSupport] = useState(false);
  const [supportSent, setSupportSent] = useState(false);
  const [isChangingPlan, setIsChangingPlan] = useState(false);
  const [planChangeDialogOpen, setPlanChangeDialogOpen] = useState(false);
  const [planChangePreview, setPlanChangePreview] = useState<{
    currentPlan: string;
    newPlan: string;
    newPrice: number;
    message: string;
    targetPlanType: string;
  } | null>(null);
  const [cancelSubscriptionDialogOpen, setCancelSubscriptionDialogOpen] = useState(false);
  const [isCancellingSubscription, setIsCancellingSubscription] = useState(false);
  const [cancelConfirmationText, setCancelConfirmationText] = useState('');
  const [isOpeningPaymentPortal, setIsOpeningPaymentPortal] = useState(false);
  const [showFirstLoginDialog, setShowFirstLoginDialog] = useState(false);
  const [isFirstLoginSubmitting, setIsFirstLoginSubmitting] = useState(false);
  const [selectedProfileIcon, setSelectedProfileIcon] = useState<string>('user');
  const [showFirstLoginPassword, setShowFirstLoginPassword] = useState(false);
  const [showFirstLoginConfirm, setShowFirstLoginConfirm] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryType, setNewCategoryType] = useState<'income' | 'expense'>('income');
  const [newCategorySubtype, setNewCategorySubtype] = useState<'cost' | 'expense'>('expense');
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  const [pendingSubtypeChange, setPendingSubtypeChange] = useState<{ categoryId: string; categoryName: string; currentSubtype: string; newSubtype: string } | null>(null);
  const [isApplyingSubtype, setIsApplyingSubtype] = useState(false);
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [pendingDeleteCategory, setPendingDeleteCategory] = useState<{ id: string; name: string; type: 'income' | 'expense'; count: number; reassignTo: string } | null>(null);
  const [deletingCategory, setDeletingCategory] = useState(false);
  const [createAccountDialogOpen, setCreateAccountDialogOpen] = useState(false);
  const [leaveTeamDialogOpen, setLeaveTeamDialogOpen] = useState(false);
  const [orgToLeave, setOrgToLeave] = useState<{ id: string; name: string } | null>(null);
  const [isLeavingTeam, setIsLeavingTeam] = useState(false);
  const [isSavingWaPrefs, setIsSavingWaPrefs] = useState(false);
  const [waSelectedOrgId, setWaSelectedOrgId] = useState<string>('');
  const [isSavingDashPrefs, setIsSavingDashPrefs] = useState(false);
  const [dashSelectedOrgId, setDashSelectedOrgId] = useState<string>('');
  const queryClient = useQueryClient();

  // Detect if user is a guest (invited member without own subscription)
  const isGuest = !user?.planType && !subscriptionStatus?.hasSubscription;

  useEffect(() => {
    if (organization?.id && !waSelectedOrgId) {
      setWaSelectedOrgId(organization.id);
    }
    if (organization?.id && !dashSelectedOrgId) {
      setDashSelectedOrgId(organization.id);
    }
  }, [organization?.id]);

  const { data: waPrefs, refetch: refetchWaPrefs } = useQuery<{
    preferredAccountId: string | null;
    preferredCurrency: string | null;
    preferredExpenseCategory: string | null;
    preferredIncomeCategory: string | null;
    defaultHasInvoice: boolean | null;
    orgBannerIntervalHours: number | null;
  }>({
    queryKey: ["/whatsapp-preferences", waSelectedOrgId],
    queryFn: () => fetchWithAuth(`/whatsapp-preferences?organizationId=${waSelectedOrgId}`),
    enabled: !!waSelectedOrgId,
  });

  const { data: waOrgData } = useQuery<{
    accounts: Array<{ id: string; name: string; currency: string }>;
    expenseCategories: Array<{ id: string; name: string; type: string }>;
    incomeCategories: Array<{ id: string; name: string; type: string }>;
  }>({
    queryKey: ["/whatsapp-preferences/org-data", waSelectedOrgId],
    queryFn: () => fetchWithAuth(`/whatsapp-preferences/org-data?organizationId=${waSelectedOrgId}`),
    enabled: !!waSelectedOrgId,
  });

  const waAccountsList = waOrgData?.accounts || [];
  const waExpenseCats = waOrgData?.expenseCategories || [];
  const waIncomeCats = waOrgData?.incomeCategories || [];

  const [waAccountId, setWaAccountId] = useState<string>('');
  const [waExpenseCategory, setWaExpenseCategory] = useState<string>('');
  const [waIncomeCategory, setWaIncomeCategory] = useState<string>('');
  const [waHasInvoice, setWaHasInvoice] = useState<boolean | null>(null);
  // Task #210 — Intervalo del recordatorio de organización por WhatsApp.
  // 'default' (=null en DB → 6 h), '1', '3', '6', '12', '24' (horas) o
  // 'never' (=0 en DB → no mostrar nunca).
  const [waOrgBannerInterval, setWaOrgBannerInterval] = useState<string>('default');

  useEffect(() => {
    if (waPrefs) {
      setWaAccountId(waPrefs.preferredAccountId || '');
      setWaExpenseCategory(waPrefs.preferredExpenseCategory || '');
      setWaIncomeCategory(waPrefs.preferredIncomeCategory || '');
      setWaHasInvoice(waPrefs.defaultHasInvoice);
      const v = waPrefs.orgBannerIntervalHours;
      if (v === null || v === undefined) {
        setWaOrgBannerInterval('default');
      } else if (v === 0) {
        setWaOrgBannerInterval('never');
      } else {
        setWaOrgBannerInterval(String(v));
      }
    } else {
      setWaAccountId('');
      setWaExpenseCategory('');
      setWaIncomeCategory('');
      setWaHasInvoice(null);
      setWaOrgBannerInterval('default');
    }
  }, [waPrefs, waSelectedOrgId]);

  // Organización por defecto del bot de WhatsApp.
  // Es independiente de la org activa de la web. Si está vacía, el bot
  // cae al fallback histórico (lastActiveOrganizationId).
  const { data: waDefaultOrg, refetch: refetchWaDefaultOrg } = useQuery<{
    organizationId: string | null;
    valid: boolean;
  }>({
    queryKey: ["/user/whatsapp-default-organization"],
    queryFn: () => fetchWithAuth('/user/whatsapp-default-organization'),
  });

  const [isSavingWaDefault, setIsSavingWaDefault] = useState(false);

  const handleSaveWaDefaultOrg = async (newOrgId: string | null) => {
    setIsSavingWaDefault(true);
    try {
      await fetchWithAuth('/user/whatsapp-default-organization', {
        method: 'PUT',
        body: JSON.stringify({ organizationId: newOrgId || null }),
      });
      await refetchWaDefaultOrg();
      const orgName = newOrgId ? (organizations.find((o: { id: string; name: string }) => o.id === newOrgId)?.name || '') : '';
      if (!newOrgId) {
        toast({
          title: "Organización por defecto eliminada",
          description: 'El bot ya no tiene una organización por defecto. Te va a preguntar cuando haga falta.',
        });
      } else {
        toast({
          title: "Organización por defecto actualizada",
          description: `El bot de WhatsApp ahora registra movimientos en ${orgName} por defecto.`,
        });
      }
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "No se pudo actualizar", variant: "destructive" });
    } finally {
      setIsSavingWaDefault(false);
    }
  };

  const handleSaveWaPrefs = async () => {
    if (!waSelectedOrgId) return;
    setIsSavingWaPrefs(true);
    try {
      // Task #210 — convertir el value del select al entero/null que espera el server.
      let orgBannerIntervalHoursPayload: number | null;
      if (waOrgBannerInterval === 'default') {
        orgBannerIntervalHoursPayload = null;
      } else if (waOrgBannerInterval === 'never') {
        orgBannerIntervalHoursPayload = 0;
      } else {
        const parsed = parseInt(waOrgBannerInterval, 10);
        orgBannerIntervalHoursPayload = Number.isFinite(parsed) ? parsed : null;
      }
      const result: unknown = await fetchWithAuth('/whatsapp-preferences', {
        method: 'PUT',
        body: JSON.stringify({
          organizationId: waSelectedOrgId,
          preferredAccountId: waAccountId || null,
          preferredExpenseCategory: waExpenseCategory || null,
          preferredIncomeCategory: waIncomeCategory || null,
          defaultHasInvoice: waHasInvoice,
          orgBannerIntervalHours: orgBannerIntervalHoursPayload,
        }),
      });
      refetchWaPrefs();
      const orgName = organizations.find((o: { id: string; name: string }) => o.id === waSelectedOrgId)?.name || '';
      toast({ title: "Preferencias guardadas", description: `Preferencias del bot actualizadas para ${orgName}` });
      // Si el server auto-asignó esta org como default del bot, avisamos.
      if (isWhatsappPreferencesResponse(result) && result.autoAssignedDefault === true) {
        await refetchWaDefaultOrg();
        toast({
          title: "Organización por defecto asignada",
          description: `El bot de WhatsApp ahora usa ${orgName} por defecto. Podés cambiarla acá arriba.`,
        });
      }
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "No se pudieron guardar las preferencias", variant: "destructive" });
    } finally {
      setIsSavingWaPrefs(false);
    }
  };

  const { data: dashPrefs, refetch: refetchDashPrefs } = useQuery<{
    preferredAccountId: string | null;
    preferredCurrency: string | null;
    preferredExpenseCategory: string | null;
    preferredIncomeCategory: string | null;
    defaultHasInvoice: boolean | null;
  }>({
    queryKey: ["/dashboard-preferences", dashSelectedOrgId],
    queryFn: () => fetchWithAuth(`/dashboard-preferences?organizationId=${dashSelectedOrgId}`),
    enabled: !!dashSelectedOrgId,
  });

  const { data: dashOrgData } = useQuery<{
    accounts: Array<{ id: string; name: string; currency: string }>;
    expenseCategories: Array<{ id: string; name: string; type: string }>;
    incomeCategories: Array<{ id: string; name: string; type: string }>;
  }>({
    queryKey: ["/whatsapp-preferences/org-data", dashSelectedOrgId],
    queryFn: () => fetchWithAuth(`/whatsapp-preferences/org-data?organizationId=${dashSelectedOrgId}`),
    enabled: !!dashSelectedOrgId,
  });

  const dashAccountsList = dashOrgData?.accounts || [];
  const dashExpenseCats = dashOrgData?.expenseCategories || [];
  const dashIncomeCats = dashOrgData?.incomeCategories || [];

  const [dashAccountId, setDashAccountId] = useState<string>('');
  const [dashExpenseCategory, setDashExpenseCategory] = useState<string>('');
  const [dashIncomeCategory, setDashIncomeCategory] = useState<string>('');
  const [dashHasInvoice, setDashHasInvoice] = useState<boolean | null>(null);

  useEffect(() => {
    if (dashPrefs) {
      setDashAccountId(dashPrefs.preferredAccountId || '');
      setDashExpenseCategory(dashPrefs.preferredExpenseCategory || '');
      setDashIncomeCategory(dashPrefs.preferredIncomeCategory || '');
      setDashHasInvoice(dashPrefs.defaultHasInvoice);
    } else {
      setDashAccountId('');
      setDashExpenseCategory('');
      setDashIncomeCategory('');
      setDashHasInvoice(null);
    }
  }, [dashPrefs, dashSelectedOrgId]);

  const handleSaveDashPrefs = async () => {
    if (!dashSelectedOrgId) return;
    setIsSavingDashPrefs(true);
    try {
      await fetchWithAuth('/dashboard-preferences', {
        method: 'PUT',
        body: JSON.stringify({
          organizationId: dashSelectedOrgId,
          preferredAccountId: dashAccountId || null,
          preferredExpenseCategory: dashExpenseCategory || null,
          preferredIncomeCategory: dashIncomeCategory || null,
          defaultHasInvoice: dashHasInvoice,
        }),
      });
      refetchDashPrefs();
      const orgName = organizations.find((o: { id: string; name: string }) => o.id === dashSelectedOrgId)?.name || '';
      toast({ title: "Preferencias guardadas", description: `Preferencias del dashboard actualizadas para ${orgName}` });
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "No se pudieron guardar las preferencias", variant: "destructive" });
    } finally {
      setIsSavingDashPrefs(false);
    }
  };

  const { data: categories = [] } = useQuery<Array<{id: string; name: string; type: string; isDefault: boolean; expenseSubtype: string | null; archivedAt?: string | null}>>({
    queryKey: ["/organization/categories", { includeArchived: true }],
    queryFn: () => fetchWithAuth("/organization/categories?includeArchived=true"),
  });

  // Task #363: separar activas de archivadas
  const activeCategories = categories.filter(c => !c.archivedAt);
  const archivedCategories = categories.filter(c => !!c.archivedAt);
  const incomeCategories = activeCategories.filter(c => c.type === 'income');
  const expenseCategories = activeCategories.filter(c => c.type === 'expense');

  const isOwnerOrAdmin = !!membership && (membership.role === 'owner' || membership.role === 'admin');

  const unarchiveCategoryMutation = useMutation({
    mutationFn: (id: string) => categoryAPI.unarchive(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/organization/categories"] });
      toast({ title: "Categoría restaurada" });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const hardDeleteCategoryMutation = useMutation({
    mutationFn: (id: string) => categoryAPI.delete(id, { force: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/organization/categories"] });
      queryClient.invalidateQueries({ queryKey: ["/transactions"] });
      toast({ title: "Categoría eliminada definitivamente" });
    },
    onError: (err: any) => toast({ title: "No se puede eliminar", description: err.message, variant: "destructive" }),
  });

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) return;
    setIsCreatingCategory(true);
    try {
      const createBody: { name: string; type: string; expenseSubtype?: string } = { name: newCategoryName.trim(), type: newCategoryType };
      if (newCategoryType === 'expense') {
        createBody.expenseSubtype = newCategorySubtype;
      }
      await fetchWithAuth("/organization/categories", {
        method: "POST",
        body: JSON.stringify(createBody),
      });
      setNewCategoryName('');
      queryClient.invalidateQueries({ queryKey: ["/organization/categories"] });
      toast({ title: "Categoría creada", description: `"${newCategoryName}" agregada correctamente.` });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setIsCreatingCategory(false);
    }
  };

  const handleUpdateCategory = async (id: string) => {
    if (!editingCategoryName.trim()) return;
    try {
      await fetchWithAuth(`/organization/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editingCategoryName.trim() }),
      });
      setEditingCategoryId(null);
      queryClient.invalidateQueries({ queryKey: ["/organization/categories"] });
      toast({ title: "Categoría actualizada" });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleDeleteCategory = async (id: string, name: string, type: 'income' | 'expense') => {
    try {
      const usage = await fetchWithAuth(`/organization/categories/${id}/usage`);
      setPendingDeleteCategory({
        id,
        name,
        type,
        count: usage?.count ?? 0,
        reassignTo: '',
      });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const confirmDeleteCategory = async (opts: { skipReassign?: boolean } = {}) => {
    if (!pendingDeleteCategory) return;
    const { id, count, reassignTo } = pendingDeleteCategory;
    const useReassign = !opts.skipReassign && !!reassignTo;
    if (count > 0 && !useReassign && !opts.skipReassign) {
      toast({
        title: "Elegí una categoría",
        description: "Elegí una categoría de reemplazo o confirmá eliminar sin reasignar.",
        variant: "destructive",
      });
      return;
    }
    setDeletingCategory(true);
    try {
      const body = useReassign ? { reassignTo } : undefined;
      const result = await fetchWithAuth(`/organization/categories/${id}`, {
        method: "DELETE",
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      queryClient.invalidateQueries({ queryKey: ["/organization/categories"] });
      queryClient.invalidateQueries({ queryKey: ["/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/organization/categories/ghosts"] });
      const reassigned = result?.reassignedCount ?? 0;
      // Task #363: el servidor archiva en vez de borrar si hay movimientos sin reasignar.
      if (result?.archived) {
        toast({
          title: "Categoría archivada",
          description: "Tenía movimientos asociados, así que se conservó como archivada.",
        });
      } else {
        toast({
          title: "Categoría eliminada",
          description: reassigned > 0 ? `Se reasignaron ${reassigned} movimiento(s).` : undefined,
        });
      }
      setPendingDeleteCategory(null);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setDeletingCategory(false);
    }
  };

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('firstLogin') === 'true' && user?.mustChangePassword) {
      setShowFirstLoginDialog(true);
      setSelectedProfileIcon(user?.profileIconKey || 'user');
    }
    
    if (urlParams.get('checkout') === 'success') {
      const planName = urlParams.get('plan');
      toast({
        title: "¡Suscripción activada!",
        description: planName 
          ? `Tu plan ${PLAN_LABELS[planName as PlanType] || planName} está activo.`
          : "Tu suscripción ha sido procesada correctamente.",
      });
      queryClient.invalidateQueries({ queryKey: ['user'] });
      queryClient.invalidateQueries({ queryKey: ['/subscription/limits'] });
      window.history.replaceState({}, '', '/settings');
    }
    
    if (urlParams.get('checkout') === 'cancelled') {
      toast({
        title: "Pago cancelado",
        description: "El proceso de pago fue cancelado. Podés intentarlo de nuevo cuando quieras.",
        variant: "destructive",
      });
      window.history.replaceState({}, '', '/settings');
    }
  }, [user, toast, queryClient]);

  const userForm = useForm<UserProfileFormValues>({
    resolver: zodResolver(userProfileSchema),
    values: {
      name: user?.name || '',
      email: user?.email || '',
    },
  });

  const passwordForm = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });

  const firstLoginForm = useForm<FirstLoginFormValues>({
    resolver: zodResolver(firstLoginSchema),
    values: {
      name: user?.name || '',
      newPassword: '',
      confirmPassword: '',
    },
  });

  const onFirstLoginSubmit = async (data: FirstLoginFormValues) => {
    try {
      setIsFirstLoginSubmitting(true);
      
      await fetchWithAuth('/auth/first-login-setup', {
        method: 'POST',
        body: JSON.stringify({
          name: data.name,
          newPassword: data.newPassword,
          profileIconKey: selectedProfileIcon,
        }),
      });
      
      toast({
        title: "¡Bienvenido!",
        description: "Tu cuenta ha sido configurada correctamente.",
      });
      
      setShowFirstLoginDialog(false);
      queryClient.invalidateQueries({ queryKey: ['/api/user'] });
      window.history.replaceState({}, '', '/settings');
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo configurar la cuenta",
        variant: "destructive",
      });
    } finally {
      setIsFirstLoginSubmitting(false);
    }
  };

  const onUserSubmit = async (data: UserProfileFormValues) => {
    try {
      await updateUserMutation.mutateAsync(data);
      toast({
        title: "Perfil actualizado",
        description: "Tus datos personales han sido guardados.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo actualizar el perfil",
        variant: "destructive",
      });
    }
  };

  const onPasswordSubmit = async (data: PasswordFormValues) => {
    try {
      setIsChangingPassword(true);
      await fetchWithAuth('/user/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: data.currentPassword,
          newPassword: data.newPassword,
        }),
      });
      
      toast({
        title: "Contraseña actualizada",
        description: "Tu contraseña ha sido cambiada correctamente.",
      });
      passwordForm.reset();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo cambiar la contraseña",
        variant: "destructive",
      });
    } finally {
      setIsChangingPassword(false);
    }
  };

  // Step 1 of the verification flow — ask the server to send a 6-digit
  // code via WhatsApp to the typed number. The user must then prove
  // control by pasting the code back in step 2.
  const handleSendCode = async () => {
    if (!phoneNumber.trim()) return;
    try {
      setIsSavingPhone(true);
      const result = await fetchWithAuth('/user/phone/send-code', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber: phoneNumber.trim() }),
      });
      setPendingPhone(result.phoneNumber);
      setPendingDisplayPhone(result.displayPhone || result.phoneNumber);
      setPhoneStep('enter-code');
      setVerificationCode('');
      setResendCooldownSec(45);
      toast({
        title: "Código enviado",
        description: result.message || "Te enviamos un código por WhatsApp.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No pudimos enviar el código",
        variant: "destructive",
      });
    } finally {
      setIsSavingPhone(false);
    }
  };

  // Step 2 — submit the 6-digit code to the server, which validates and
  // (on success) writes phoneNumber + phoneVerified=true on the current user.
  const handleVerifyCode = async () => {
    if (!verificationCode.trim()) return;
    try {
      setIsVerifyingCode(true);
      const result = await fetchWithAuth('/user/phone/verify-code', {
        method: 'POST',
        body: JSON.stringify({ code: verificationCode.trim() }),
      });
      toast({
        title: "Número verificado",
        description: result.message || "Tu número fue verificado correctamente.",
      });
      setIsEditingPhone(false);
      setPhoneStep('greet-bot');
      setPhoneNumber('');
      setVerificationCode('');
      setPendingPhone(null);
      setPendingDisplayPhone(null);
      setBotGreeted(false);
      setShowNotReceivedHint(false);
      queryClient.invalidateQueries({ queryKey: ['user'] });
    } catch (error: any) {
      toast({
        title: "Código inválido",
        description: error.message || "El código no coincide. Probá de nuevo.",
        variant: "destructive",
      });
    } finally {
      setIsVerifyingCode(false);
    }
  };

  const handleResendCode = async () => {
    if (!pendingPhone || resendCooldownSec > 0) return;
    setPhoneNumber(pendingPhone);
    await handleSendCode();
  };

  const handleCancelVerification = () => {
    setIsEditingPhone(false);
    setPhoneStep('greet-bot');
    setPhoneNumber('');
    setVerificationCode('');
    setPendingPhone(null);
    setPendingDisplayPhone(null);
    setBotGreeted(false);
    setShowNotReceivedHint(false);
  };

  const handleDeletePhone = async () => {
    try {
      setIsDeletingPhone(true);
      await fetchWithAuth('/user/phone', {
        method: 'DELETE',
      });
      
      toast({
        title: "Número desvinculado",
        description: "Tu número de WhatsApp ha sido desvinculado.",
      });
      queryClient.invalidateQueries({ queryKey: ['user'] });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo desvincular el número",
        variant: "destructive",
      });
    } finally {
      setIsDeletingPhone(false);
    }
  };

  const handleAskHelp = async () => {
    if (!helpQuestion.trim()) return;
    
    try {
      setIsAskingHelp(true);
      setHelpAnswer('');
      const data = await fetchWithAuth('/ai/help', {
        method: 'POST',
        body: JSON.stringify({ question: helpQuestion }),
      });
      setHelpAnswer(data.answer);
    } catch (error: any) {
      setHelpAnswer('Lo siento, no pude procesar tu pregunta. Por favor, intentá de nuevo.');
    } finally {
      setIsAskingHelp(false);
    }
  };

  const handleSendSupport = async () => {
    if (!supportSubject.trim() || !supportMessage.trim()) return;
    
    try {
      setIsSendingSupport(true);
      const result = await fetchWithAuth('/support', {
        method: 'POST',
        body: JSON.stringify({ 
          subject: supportSubject.trim(), 
          message: supportMessage.trim(),
          contactEmail: supportContactEmail.trim() || undefined
        }),
      });
      
      setSupportSent(true);
      setSupportSubject('');
      setSupportMessage('');
      setSupportContactEmail('');
      toast({
        title: "Mensaje enviado",
        description: result.message || "Tu consulta fue enviada. Te responderemos pronto.",
      });
      
      setTimeout(() => setSupportSent(false), 5000);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo enviar el mensaje. Intentá de nuevo.",
        variant: "destructive",
      });
    } finally {
      setIsSendingSupport(false);
    }
  };

  const { data: stripeProducts } = useQuery<Array<{
    id: string;
    name: string;
    metadata: { planType?: string };
    prices: Array<{ id: string; unitAmount: number; currency: string }>;
  }>>({
    queryKey: ["/stripe/products"],
    queryFn: () => fetchWithAuth("/stripe/products"),
  });

  const handleSyncSubscription = async () => {
    try {
      setIsSyncingSubscription(true);
      const result = await fetchWithAuth('/subscription/sync', {
        method: 'POST',
      });
      
      if (result.success) {
        toast({
          title: "Sincronizado",
          description: `Tu suscripción fue vinculada correctamente. Plan: ${result.planType}`,
        });
        // Invalidate all subscription and user related caches
        queryClient.invalidateQueries({ queryKey: ['/subscription/status'] });
        queryClient.invalidateQueries({ queryKey: ['/subscription/limits'] });
        queryClient.invalidateQueries({ queryKey: ['user'] });
        queryClient.invalidateQueries({ queryKey: ['/stripe/products'] });
        refetchSubscriptionStatus();
      } else {
        toast({
          title: "No se encontró suscripción",
          description: result.message,
          variant: "destructive",
        });
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo sincronizar la suscripción",
        variant: "destructive",
      });
    } finally {
      setIsSyncingSubscription(false);
    }
  };

  const handleChangePlan = async (planType: PlanType) => {
    if (planType === user?.planType) return;
    
    const newPlanDetails = PLAN_DETAILS[planType];
    const priceFormatted = newPlanDetails.price.toLocaleString('es-AR');
    const planLabel = PLAN_LABELS[planType];
    
    let message: string;
    if (subscriptionStatus?.isTrialing && subscriptionStatus?.trialDaysRemaining !== null && subscriptionStatus?.trialDaysRemaining !== undefined && subscriptionStatus.trialDaysRemaining > 0) {
      // Trial users: warn that trial will end and they'll be charged immediately
      message = `Tu período de prueba gratuito se cancelará y se te cobrará $${priceFormatted} ahora por el plan ${planLabel}.`;
    } else {
      message = `Se te cobrará $${priceFormatted} por el plan ${planLabel}. Tu plan actual se cancelará.`;
    }
    
    setPlanChangePreview({
      targetPlanType: planType,
      newPlan: planLabel,
      currentPlan: user?.planType ? PLAN_LABELS[user.planType as PlanType] : 'Sin plan',
      newPrice: newPlanDetails.price * 100,
      message,
    });
    setPlanChangeDialogOpen(true);
  };

  const handleConfirmPlanChange = async () => {
    if (!planChangePreview) return;
    
    const targetPlanType = planChangePreview.targetPlanType;
    const newPlanLabel = planChangePreview.newPlan;
    
    try {
      setIsChangingPlan(true);
      
      const result = await fetchWithAuth('/subscription/change-plan', {
        method: 'POST',
        body: JSON.stringify({ planType: targetPlanType }),
      });
      
      // If backend returns a checkout URL, redirect to it
      if (result.url) {
        // Save checkout session ID for session recovery after Stripe redirect
        // This helps mobile browsers that may lose cookies
        if (result.sessionId) {
          localStorage.setItem('aikestar_checkout_session', result.sessionId);
          localStorage.setItem('aikestar_checkout_time', Date.now().toString());
        }
        // Reset state before redirecting so dialog is closed if user returns
        setPlanChangeDialogOpen(false);
        setPlanChangePreview(null);
        setIsChangingPlan(false);
        window.location.href = result.url;
        return;
      }
      
      // Plan was updated directly (e.g., during trial period)
      const description = result.message || `Tu plan fue actualizado a ${newPlanLabel}.`;
      toast({
        title: "Plan actualizado",
        description,
      });
      
      await queryClient.invalidateQueries({ queryKey: ['user'] });
      await queryClient.invalidateQueries({ queryKey: ['/subscription/limits'] });
      setPlanChangeDialogOpen(false);
      setPlanChangePreview(null);
      setIsChangingPlan(false);
    } catch (error: any) {
      // If subscription not linked, try to create a checkout session directly
      if (error.code === 'SUBSCRIPTION_NOT_LINKED' || error.code === 'NO_SUBSCRIPTION') {
        try {
          let products = stripeProducts;
          if (!products || products.length === 0) {
            products = await fetchWithAuth('/stripe/products');
          }
          
          const targetProduct = products?.find((p: any) => p.metadata?.planType === targetPlanType);
          const priceId = targetProduct?.prices?.[0]?.id;
          
          if (priceId) {
            const checkoutResult = await fetchWithAuth('/stripe/create-checkout-session', {
              method: 'POST',
              body: JSON.stringify({ priceId }),
            });
            if (checkoutResult.url) {
              // Save checkout session ID for session recovery after Stripe redirect
              if (checkoutResult.sessionId) {
                localStorage.setItem('aikestar_checkout_session', checkoutResult.sessionId);
                localStorage.setItem('aikestar_checkout_time', Date.now().toString());
              }
              // Reset state before redirecting
              setPlanChangeDialogOpen(false);
              setPlanChangePreview(null);
              setIsChangingPlan(false);
              window.location.href = checkoutResult.url;
              return;
            }
          }
          
          // If we couldn't find the product/price, show error
          setIsChangingPlan(false);
          toast({
            title: "Error",
            description: "No se encontró el plan seleccionado. Por favor recargá la página e intentá de nuevo.",
            variant: "destructive",
          });
          return;
        } catch (checkoutError: any) {
          setIsChangingPlan(false);
          toast({
            title: "Error",
            description: checkoutError.message || "No se pudo iniciar el proceso de pago",
            variant: "destructive",
          });
          return;
        }
      }
      
      setIsChangingPlan(false);
      toast({
        title: "Error",
        description: error.message || "No se pudo cambiar el plan",
        variant: "destructive",
      });
    }
  };

  const handleCancelSubscription = async () => {
    try {
      setIsCancellingSubscription(true);
      const response = await fetchWithAuth('/subscription/cancel', {
        method: 'POST',
      });
      
      setCancelSubscriptionDialogOpen(false);
      setCancelConfirmationText('');
      
      // Invalidate subscription queries to refresh UI
      queryClient.invalidateQueries({ queryKey: ['/subscription/limits'] });
      queryClient.invalidateQueries({ queryKey: ['/subscription/status'] });
      
      const accessEndsAt = response.accessEndsAt ? new Date(response.accessEndsAt).toLocaleDateString('es-AR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      }) : 'el final del período';
      
      toast({
        title: "Suscripción cancelada",
        description: `Seguirás teniendo acceso hasta ${accessEndsAt}. Después, tus datos se conservarán por 60 días para que puedas volver a suscribirte.`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo cancelar la suscripción",
        variant: "destructive",
      });
    } finally {
      setIsCancellingSubscription(false);
    }
  };

  const handleOpenPaymentPortal = async () => {
    try {
      setIsOpeningPaymentPortal(true);
      const result = await fetchWithAuth('/stripe/create-portal-session', {
        method: 'POST',
      });
      
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo abrir el portal de pagos",
        variant: "destructive",
      });
      setIsOpeningPaymentPortal(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteAccountPassword !== 'CANCELAR') return;
    
    try {
      setIsDeletingAccount(true);
      await fetchWithAuth('/account/delete', {
        method: 'POST',
        body: JSON.stringify({ confirmDeletion: true }),
      });
      
      // Clear all caches before redirect
      queryClient.clear();
      
      setDeleteAccountDialogOpen(false);
      setDeleteAccountPassword('');
      
      toast({
        title: "Cuenta eliminada",
        description: "Tu cuenta y todos tus datos han sido eliminados.",
      });
      
      // Redirect to auth page after short delay
      setTimeout(() => {
        window.location.href = '/login?cancelled=true';
      }, 1500);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo eliminar la cuenta",
        variant: "destructive",
      });
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const handleLeaveTeam = async () => {
    if (!orgToLeave) return;
    
    try {
      setIsLeavingTeam(true);
      await fetchWithAuth(`/organizations/${orgToLeave.id}/leave`, {
        method: 'POST',
      });
      
      queryClient.invalidateQueries({ queryKey: ['/organizations'] });
      queryClient.invalidateQueries({ queryKey: ['/user/membership'] });
      
      setLeaveTeamDialogOpen(false);
      setOrgToLeave(null);
      
      toast({
        title: "Te desafiliaste del equipo",
        description: `Ya no sos parte de ${orgToLeave.name}.`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo abandonar el equipo",
        variant: "destructive",
      });
    } finally {
      setIsLeavingTeam(false);
    }
  };

  const handleEditOrg = (org: any) => {
    setEditingOrgId(org.id);
    setEditingOrgName(org.name);
  };

  const handleSaveOrgName = async (orgId: string) => {
    if (!editingOrgName.trim()) return;
    try {
      await updateOrgMutation.mutateAsync({ id: orgId, data: { name: editingOrgName } });
      toast({
        title: "Organización actualizada",
        description: "El nombre ha sido guardado.",
      });
      setEditingOrgId(null);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo actualizar la organización",
        variant: "destructive",
      });
    }
  };

  const handleCancelEdit = () => {
    setEditingOrgId(null);
    setEditingOrgName('');
  };

  const handleOpenBrandPicker = (org: any) => {
    setBrandPickerOrg({ id: org.id, logoUrl: org.logoUrl, iconKey: org.iconKey, contactEmail: org.contactEmail, contactPhone: org.contactPhone });
    setBrandPickerOpen(true);
  };

  const handleSaveBrand = async (data: { logoUrl?: string | null; iconKey?: string | null; contactEmail?: string | null; contactPhone?: string | null }) => {
    if (!brandPickerOrg) return;
    await updateOrgMutation.mutateAsync({ 
      id: brandPickerOrg.id, 
      data: {
        logoUrl: data.logoUrl,
        iconKey: data.iconKey,
        contactEmail: data.contactEmail,
        contactPhone: data.contactPhone,
      }
    });
    toast({
      title: "Datos guardados",
      description: "El logo y los datos de contacto de la organización se guardaron.",
    });
  };

  const handleDeleteClick = (org: any) => {
    setOrgToDelete({ id: org.id, name: org.name });
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!orgToDelete) return;
    try {
      await deleteOrgMutation.mutateAsync(orgToDelete.id);
      toast({
        title: "Organización eliminada",
        description: `${orgToDelete.name} ha sido eliminada.`,
      });
      setDeleteDialogOpen(false);
      setOrgToDelete(null);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "No se pudo eliminar la organización",
        variant: "destructive",
      });
    }
  };

  const isPersonalAccount = user?.accountType === 'personal';
  // Gating de Facturador / Condiciones impositivas: alineado con
  // `transactions.tsx` que ya muestra el botón "Emitir factura" a Personal Pro.
  // Antes esta página usaba `!isPersonalAccount` (más restrictivo) y dejaba a
  // los Pro sin forma de configurar el Facturador, generando incoherencia
  // (podían emitir pero no activar/configurar). Ticket de Juan: "El plan
  // personal pro muestra las secciones de facturas e impuestos pero en
  // configuración no aparecen. Agregarlos."
  const isPersonalBasic = useIsPersonalBasic();

  const searchString = useSearch();
  const [, setLocation] = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const tab = params.get('tab');
    if (tab === 'plan') {
      setTimeout(() => {
        const planTrigger = document.querySelector('[data-testid="accordion-plan"]') as HTMLButtonElement;
        if (planTrigger) {
          const isOpen = planTrigger.getAttribute('data-state') === 'open';
          if (!isOpen) {
            planTrigger.click();
          }
          planTrigger.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        setLocation('/settings', { replace: true });
      }, 100);
    }
    if (tab === 'organizations') {
      setTimeout(() => {
        const orgTrigger = document.querySelector('[data-testid="accordion-organizations"]') as HTMLButtonElement;
        if (orgTrigger) {
          const isOpen = orgTrigger.getAttribute('data-state') === 'open';
          if (!isOpen) {
            orgTrigger.click();
          }
          orgTrigger.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        setLocation('/settings', { replace: true });
      }, 100);
    }
    if (tab === 'whatsapp') {
      // Task #219: deep-link from the dashboard banner can request the
      // verification wizard to be opened automatically (?openWizard=1).
      // The wizard auto-open itself runs in a separate effect that waits
      // for the `user` query to resolve. To avoid a race where this branch
      // and the wizard effect fight over the URL (one stripping `openWizard`,
      // the other re-adding it), we hand off URL stewardship: if `openWizard`
      // is present, leave the URL alone here and let the wizard effect do
      // the single, definitive strip after consuming the param. Otherwise,
      // clean up the `tab` param normally.
      const wantsWizard = params.get('openWizard') === '1';
      setTimeout(() => {
        const waTrigger = document.querySelector('[data-testid="accordion-whatsapp"]') as HTMLButtonElement;
        if (waTrigger) {
          const isOpen = waTrigger.getAttribute('data-state') === 'open';
          if (!isOpen) {
            waTrigger.click();
          }
          waTrigger.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        if (!wantsWizard) {
          setLocation('/settings', { replace: true });
        }
      }, 100);
    }
    if (tab === 'team') {
      setTimeout(() => {
        const teamTrigger = document.querySelector('[data-testid="accordion-team"]') as HTMLButtonElement;
        if (teamTrigger) {
          const isOpen = teamTrigger.getAttribute('data-state') === 'open';
          if (!isOpen) {
            teamTrigger.click();
          }
          teamTrigger.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        setLocation('/settings', { replace: true });
      }, 100);
    }
    if (tab === 'integrations') {
      setTimeout(() => {
        const t = document.querySelector('[data-testid="accordion-integrations"]') as HTMLButtonElement;
        if (t) {
          const isOpen = t.getAttribute('data-state') === 'open';
          if (!isOpen) t.click();
          t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        // Conservamos ?tiendanube=connected/error si vino del callback OAuth.
        if (!params.get('tiendanube')) setLocation('/settings', { replace: true });
      }, 150);
    }
    if (tab === 'audit') {
      setTimeout(() => {
        const auditTrigger = document.querySelector('[data-testid="accordion-audit"]') as HTMLButtonElement;
        if (auditTrigger) {
          const isOpen = auditTrigger.getAttribute('data-state') === 'open';
          if (!isOpen) {
            auditTrigger.click();
          }
          auditTrigger.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        setLocation('/settings', { replace: true });
      }, 100);
    }
    if (tab === 'taxes') {
      setTimeout(() => {
        const t = document.querySelector('[data-testid="accordion-taxes"]') as HTMLButtonElement;
        if (t) {
          const isOpen = t.getAttribute('data-state') === 'open';
          if (!isOpen) t.click();
          t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        setLocation('/settings', { replace: true });
      }, 100);
    }
    if (tab === 'codes') {
      setTimeout(() => {
        const t = document.querySelector('[data-testid="accordion-profitability-codes"]') as HTMLButtonElement;
        if (t) {
          const isOpen = t.getAttribute('data-state') === 'open';
          if (!isOpen) t.click();
          t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        setLocation('/settings', { replace: true });
      }, 100);
    }
  }, [searchString, setLocation]);

  // Task #219: dedicated effect that opens the WhatsApp verification wizard
  // when `?openWizard=1` is present in the URL. Runs after the user query
  // resolves so the gating check (`phoneNumber && !phoneVerified`) is real.
  // Once consumed, the param is stripped so a refresh doesn't re-pop it.
  useEffect(() => {
    const params = new URLSearchParams(searchString);
    if (params.get('openWizard') !== '1') return;
    if (!user) return; // wait for user query
    if (user.phoneNumber && !user.phoneVerified) {
      setPhoneNumber('');
      setVerificationCode('');
      setPendingPhone(null);
      setPendingDisplayPhone(null);
      setBotGreeted(false);
      setShowNotReceivedHint(false);
      setPhoneStep('greet-bot');
      setIsEditingPhone(true);
    }
    setLocation('/settings', { replace: true });
  }, [searchString, user, setLocation]);

  return (
    <>
      <div className="mb-8">
        <BackButton />
        <h1 className="text-3xl font-bold font-display mt-2">Configuración</h1>
        <p className="text-muted-foreground">Administra tu perfil, organizaciones y preferencias.</p>
      </div>

      <div className="max-w-5xl">
        <Accordion type="multiple" className="space-y-4">
          <AccordionItem value="profile" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-profile">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <User className="h-5 w-5 text-primary" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Mi Perfil</p>
                  <p className="text-sm text-muted-foreground font-normal">Foto, nombre, email y contraseña</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="space-y-6 pt-2">
                <div>
                  <UserProfilePicker
                    currentImageUrl={user?.profileImageUrl}
                    currentIconKey={user?.profileIconKey}
                    onImageChange={(url) => {
                      updateUserMutation.mutate({ profileImageUrl: url, profileIconKey: null });
                    }}
                    onIconChange={(key) => {
                      updateUserMutation.mutate({ profileIconKey: key, profileImageUrl: null });
                    }}
                    size="lg"
                    showUpload={true}
                  />
                </div>

                <div className="border-t pt-6">
                  <h4 className="font-medium mb-4">Información Personal</h4>
                  
                  {membership && organization && (
                    <div className="mb-4 p-3 bg-muted/50 rounded-lg flex items-center gap-3">
                      <Shield className="h-5 w-5 text-primary" />
                      <div>
                        <p className="text-sm font-medium">
                          Rol en {organization.name}: <span className="text-primary">{ROLE_LABELS[membership.role as Role] || membership.role}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {membership.role === 'owner' ? 'Tenés control total de la organización' : 'Sos miembro de esta organización'}
                        </p>
                      </div>
                    </div>
                  )}
                  
                  <form onSubmit={userForm.handleSubmit(onUserSubmit)} className="space-y-4 max-w-md">
                    <div className="space-y-2">
                      <Label htmlFor="name">Nombre Completo</Label>
                      <Input id="name" {...userForm.register('name')} data-testid="input-user-name" />
                      {userForm.formState.errors.name && (
                        <p className="text-xs text-red-500">{userForm.formState.errors.name.message}</p>
                      )}
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="email">Email</Label>
                      <Input id="email" {...userForm.register('email')} data-testid="input-user-email" />
                      {userForm.formState.errors.email && (
                        <p className="text-xs text-red-500">{userForm.formState.errors.email.message}</p>
                      )}
                    </div>

                    <Button type="submit" className="mt-4" data-testid="button-save-profile">
                      <Save className="mr-2 h-4 w-4" /> Guardar Cambios
                    </Button>
                  </form>
                </div>

                <div className="border-t pt-6">
                  <div className="flex items-center gap-2 mb-4">
                    <KeyRound className="h-5 w-5 text-muted-foreground" />
                    <h4 className="font-medium">Cambiar Contraseña</h4>
                  </div>
                  <form onSubmit={passwordForm.handleSubmit(onPasswordSubmit)} className="space-y-4 max-w-md">
                    <div className="space-y-2">
                      <Label htmlFor="currentPassword">Contraseña Actual</Label>
                      <Input 
                        id="currentPassword" 
                        type="password" 
                        {...passwordForm.register('currentPassword')} 
                        data-testid="input-current-password" 
                      />
                      {passwordForm.formState.errors.currentPassword && (
                        <p className="text-xs text-red-500">{passwordForm.formState.errors.currentPassword.message}</p>
                      )}
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="newPassword">Nueva Contraseña</Label>
                      <Input 
                        id="newPassword" 
                        type="password" 
                        {...passwordForm.register('newPassword')} 
                        data-testid="input-new-password" 
                      />
                      {passwordForm.formState.errors.newPassword && (
                        <p className="text-xs text-red-500">{passwordForm.formState.errors.newPassword.message}</p>
                      )}
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="confirmPassword">Confirmar Nueva Contraseña</Label>
                      <Input 
                        id="confirmPassword" 
                        type="password" 
                        {...passwordForm.register('confirmPassword')} 
                        data-testid="input-confirm-password" 
                      />
                      {passwordForm.formState.errors.confirmPassword && (
                        <p className="text-xs text-red-500">{passwordForm.formState.errors.confirmPassword.message}</p>
                      )}
                    </div>

                    <Button type="submit" variant="outline" className="mt-4" disabled={isChangingPassword} data-testid="button-change-password">
                      <Lock className="mr-2 h-4 w-4" /> {isChangingPassword ? 'Cambiando...' : 'Cambiar Contraseña'}
                    </Button>
                  </form>
                </div>

                {/* Only show delete account for owners, not for guests */}
                {!isGuest && (
                <div className="border-t pt-6">
                  <div className="p-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-500/10 dark:border-red-500/20">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <h4 className="font-medium text-red-900 dark:text-red-100">Eliminar Cuenta</h4>
                        <p className="text-sm text-red-700 dark:text-red-300 mt-1 mb-3">
                          Esta acción es permanente. Se eliminarán todos tus datos, organizaciones y movimientos.
                        </p>
                        <Button 
                          variant="destructive" 
                          size="sm"
                          onClick={() => setDeleteAccountDialogOpen(true)}
                          data-testid="button-open-delete-account"
                        >
                          <Trash2 className="mr-2 h-4 w-4" /> Eliminar mi cuenta
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
                )}

                {/* Show leave option for any org where user is not the owner */}
                {organizations.filter((org: any) => org.membershipRole !== 'owner').length > 0 && (
                <div className="border-t pt-6">
                  <div className="p-4 rounded-lg border border-orange-200 bg-orange-50 dark:bg-orange-500/10 dark:border-orange-500/20">
                    <div className="flex items-start gap-3">
                      <Users className="h-5 w-5 text-orange-600 dark:text-orange-400 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <h4 className="font-medium text-orange-900 dark:text-orange-100">Abandonar organizaciones</h4>
                        <p className="text-sm text-orange-700 dark:text-orange-300 mt-1 mb-3">
                          Podés dejar de ser parte de una organización en cualquier momento.
                        </p>
                        <div className="space-y-2">
                          {organizations.filter((org: any) => org.membershipRole !== 'owner').map((org: any) => (
                            <div key={org.id} className="flex items-center justify-between p-2 bg-white dark:bg-gray-800 rounded border">
                              <span className="text-sm font-medium">
                                {org.type === 'personal' ? (org.ownerFirstName ? `Personal de ${org.ownerFirstName}` : 'Personal') : org.name}
                              </span>
                              <Button 
                                variant="outline" 
                                size="sm"
                                onClick={() => {
                                  const displayName = org.type === 'personal' ? (org.ownerFirstName ? `Personal de ${org.ownerFirstName}` : 'Personal') : org.name;
                                  setOrgToLeave({ id: org.id, name: displayName });
                                  setLeaveTeamDialogOpen(true);
                                }}
                                data-testid={`button-leave-team-${org.id}`}
                              >
                                Abandonar
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="plan" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-plan">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <CreditCard className="h-5 w-5 text-green-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Mi Plan</p>
                  <p className="text-sm text-muted-foreground font-normal">Administrá tu suscripción</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="space-y-4 pt-2">
                {!user?.planType && organizations.some((org: any) => org.type === 'business') ? (
                  <div className="space-y-4">
                    <div className="p-4 rounded-xl border-2 border-primary/30 bg-primary/5">
                      <div className="flex items-center gap-3 mb-3">
                        <Users className="h-6 w-6 text-primary" />
                        <div>
                          <h4 className="font-semibold">Sos miembro de un equipo</h4>
                          <p className="text-sm text-muted-foreground">Fuiste invitado a colaborar en una organización</p>
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        No tenés un plan propio. Estás usando el plan del dueño del equipo.
                      </p>
                    </div>
                    
                    <div className="border-t pt-4">
                      <p className="text-sm font-medium mb-3">¿Querés tu propia cuenta?</p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <button 
                          onClick={() => setCreateAccountDialogOpen(true)}
                          className="p-4 rounded-xl border-2 border-border hover:border-primary/50 hover:bg-muted/50 transition-all text-left cursor-pointer"
                          data-testid="link-create-personal"
                        >
                          <User className="h-5 w-5 text-primary mb-2" />
                          <h5 className="font-medium">Cuenta Personal</h5>
                          <p className="text-xs text-muted-foreground mt-1">Para tus finanzas personales</p>
                          <p className="text-xs text-primary mt-2">Crear con otro email →</p>
                        </button>
                        <button 
                          onClick={() => setCreateAccountDialogOpen(true)}
                          className="p-4 rounded-xl border-2 border-border hover:border-primary/50 hover:bg-muted/50 transition-all text-left cursor-pointer"
                          data-testid="link-create-business"
                        >
                          <Building className="h-5 w-5 text-primary mb-2" />
                          <h5 className="font-medium">Cuenta Empresarial</h5>
                          <p className="text-xs text-muted-foreground mt-1">Para tu negocio o emprendimiento</p>
                          <p className="text-xs text-primary mt-2">Crear con otro email →</p>
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                <div className="mb-4">
                  <p className="text-sm text-muted-foreground">
                    Plan actual: <span className="font-semibold text-foreground">{user?.planType ? PLAN_LABELS[user.planType as PlanType] : 'Sin plan'}</span>
                  </p>
                  {planLimits && (
                    <p className="text-sm text-muted-foreground mt-1">
                      Organizaciones: {planLimits.usage.organizations}/{planLimits.limits.maxOrgs} usadas
                    </p>
                  )}
                  
                  {subscriptionStatus?.needsSync && !subscriptionStatus?.hasStripeSubscriptionId && (
                    <div className="mt-3 p-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                            Suscripción no sincronizada
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Tu suscripción de pago no está vinculada. Hacé clic en "Sincronizar" para conectarla.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleSyncSubscription}
                          disabled={isSyncingSubscription}
                          data-testid="btn-sync-subscription"
                        >
                          {isSyncingSubscription ? (
                            <>
                              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                              Sincronizando...
                            </>
                          ) : (
                            <>
                              <RefreshCw className="h-4 w-4 mr-2" />
                              Sincronizar
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                  
                  {subscriptionStatus?.hasStripeSubscriptionId && subscriptionStatus?.stripeStatus?.status === 'past_due' && (
                    <div className="mt-3 p-3 rounded-lg border border-orange-500/50 bg-orange-500/10">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-orange-700 dark:text-orange-400">
                            Pago pendiente
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Tu suscripción tiene un pago pendiente. Por favor actualizá tu método de pago en Stripe. Si pagaste con American Express, te recomendamos cambiar el método de pago a Visa o Mastercard.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  {subscriptionStatus?.hasStripeSubscriptionId && subscriptionStatus?.stripeStatus?.errorType === 'stripe_api_error' && (
                    <div className="mt-3 p-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                            Error al verificar suscripción
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            No pudimos verificar el estado de tu suscripción con Stripe. Por favor intentá más tarde.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => refetchSubscriptionStatus()}
                          data-testid="btn-retry-subscription-check"
                        >
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Reintentar
                        </Button>
                      </div>
                    </div>
                  )}
                  
                  {subscriptionStatus?.hasStripeSubscriptionId && !subscriptionStatus?.stripeSubscriptionValid && !subscriptionStatus?.stripeStatus?.errorType && subscriptionStatus?.stripeStatus?.status !== 'past_due' && (
                    <div className="mt-3 p-3 rounded-lg border border-red-500/50 bg-red-500/10">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-red-700 dark:text-red-400">
                            Suscripción inactiva
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Tu suscripción está en estado: {subscriptionStatus?.stripeStatus?.status || 'desconocido'}. Si pagaste con American Express, te recomendamos cambiar el método de pago a Visa o Mastercard.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  {subscriptionStatus && !subscriptionStatus.needsSync && subscriptionStatus.stripeSubscriptionValid && (
                    <div className="mt-3 p-3 rounded-lg border border-green-500/50 bg-green-500/10">
                      <p className="text-sm text-green-700 dark:text-green-400 flex items-center gap-2">
                        <Check className="h-4 w-4" />
                        Suscripción activa y sincronizada
                        {subscriptionStatus.stripeLiveMode && (
                          <span className="text-xs bg-green-600 text-white px-2 py-0.5 rounded">LIVE</span>
                        )}
                      </p>
                    </div>
                  )}

                  {user?.planType && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPaymentHistoryOpen(true)}
                        data-testid="btn-open-payment-history"
                      >
                        Ver historial de pagos
                      </Button>
                      {user?.stripeCustomerId && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleOpenPaymentPortal}
                          disabled={isOpeningPaymentPortal}
                          data-testid="button-manage-payment-methods"
                        >
                          {isOpeningPaymentPortal ? 'Abriendo...' : 'Gestionar métodos de pago'}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                
                <p className="text-xs text-muted-foreground mb-4" data-testid="text-amex-notice-change-plan">
                  Aceptamos Visa y Mastercard. American Express puede no funcionar en Argentina.
                </p>

                {/* Planes Personales */}
                <div className="mb-6">
                  <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                    <User className="h-4 w-4" />
                    Planes Personales
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {PLAN_TYPES.filter((planType) => !PLAN_DETAILS[planType].isTeamPlan).map((planType) => {
                      const details = PLAN_DETAILS[planType];
                      const isCurrent = user?.planType === planType;
                      const exceedsOrgLimit = planLimits && planLimits.usage.organizations > details.maxOrgs;
                      const exceedsMemberLimit = planLimits && planLimits.usage.members > details.maxMembersPerOrg;
                      const exceedsLimits = exceedsOrgLimit || exceedsMemberLimit;
                      const orgExcess = exceedsOrgLimit ? (planLimits?.usage.organizations || 0) - details.maxOrgs : 0;
                      const memberExcess = exceedsMemberLimit ? (planLimits?.usage.members || 0) - details.maxMembersPerOrg : 0;
                      
                      return (
                        <button
                          key={planType}
                          onClick={() => handleChangePlan(planType)}
                          disabled={isCurrent || isChangingPlan || !stripeProducts}
                          className={`relative p-4 rounded-xl border-2 text-left transition-all ${
                            isCurrent 
                              ? 'border-primary bg-primary/5 cursor-default' 
                              : exceedsLimits
                                ? 'border-amber-500/50 bg-amber-500/5 cursor-not-allowed opacity-75'
                                : 'border-border hover:border-primary/50 hover:bg-muted/50'
                          } ${isChangingPlan ? 'opacity-50' : ''}`}
                          data-testid={`plan-card-${planType}`}
                        >
                          {isCurrent && (
                            <div className="absolute top-3 right-3">
                              <CheckCircle className="h-5 w-5 text-primary" />
                            </div>
                          )}
                          {!isCurrent && exceedsLimits && (
                            <div className="absolute top-3 right-3">
                              <AlertTriangle className="h-5 w-5 text-amber-500" />
                            </div>
                          )}
                          <h4 className="font-semibold text-lg">{PLAN_LABELS[planType]}</h4>
                          <p className="text-2xl font-bold mt-1">
                            <span className="text-sm font-medium text-muted-foreground">ARS</span> ${details.price.toLocaleString('es-AR')}<span className="text-sm font-normal text-muted-foreground">/mes</span>
                          </p>
                          <p className="text-xs text-muted-foreground">IVA incluido</p>
                          <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                            {details.features.map((feature, i) => (
                              <li key={i}>• {feature}</li>
                            ))}
                          </ul>
                          {!isCurrent && exceedsLimits && (
                            <div className="mt-3 pt-3 border-t border-amber-500/30">
                              <p className="text-xs text-amber-600 dark:text-amber-400">
                                {exceedsOrgLimit && <span className="block">Eliminá {orgExcess} org{orgExcess > 1 ? 's' : ''} para cambiar</span>}
                                {exceedsMemberLimit && <span className="block">Reducí {memberExcess} miembro{memberExcess > 1 ? 's' : ''} para cambiar</span>}
                              </p>
                            </div>
                          )}
                          {!isCurrent && !exceedsLimits && (
                            <p className="mt-3 text-xs text-primary font-medium">
                              Clic para cambiar →
                            </p>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Planes Empresariales */}
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                    <Building className="h-4 w-4" />
                    Planes Empresariales
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {PLAN_TYPES.filter((planType) => PLAN_DETAILS[planType].isTeamPlan).map((planType) => {
                      const details = PLAN_DETAILS[planType];
                      const isCurrent = user?.planType === planType;
                      const exceedsOrgLimit = planLimits && planLimits.usage.organizations > details.maxOrgs;
                      const exceedsMemberLimit = planLimits && planLimits.usage.members > details.maxMembersPerOrg;
                      const exceedsLimits = exceedsOrgLimit || exceedsMemberLimit;
                      const orgExcess = exceedsOrgLimit ? (planLimits?.usage.organizations || 0) - details.maxOrgs : 0;
                      const memberExcess = exceedsMemberLimit ? (planLimits?.usage.members || 0) - details.maxMembersPerOrg : 0;
                      
                      return (
                        <button
                          key={planType}
                          onClick={() => handleChangePlan(planType)}
                          disabled={isCurrent || isChangingPlan || !stripeProducts}
                          className={`relative p-4 rounded-xl border-2 text-left transition-all ${
                            isCurrent 
                              ? 'border-primary bg-primary/5 cursor-default' 
                              : exceedsLimits
                                ? 'border-amber-500/50 bg-amber-500/5 cursor-not-allowed opacity-75'
                                : 'border-border hover:border-primary/50 hover:bg-muted/50'
                          } ${isChangingPlan ? 'opacity-50' : ''}`}
                          data-testid={`plan-card-${planType}`}
                        >
                          {isCurrent && (
                            <div className="absolute top-3 right-3">
                              <CheckCircle className="h-5 w-5 text-primary" />
                            </div>
                          )}
                          {!isCurrent && exceedsLimits && (
                            <div className="absolute top-3 right-3">
                              <AlertTriangle className="h-5 w-5 text-amber-500" />
                            </div>
                          )}
                          <h4 className="font-semibold text-lg">{PLAN_LABELS[planType]}</h4>
                          <p className="text-2xl font-bold mt-1">
                            <span className="text-sm font-medium text-muted-foreground">ARS</span> ${details.price.toLocaleString('es-AR')}<span className="text-sm font-normal text-muted-foreground">/mes</span>
                          </p>
                          <p className="text-xs text-muted-foreground">IVA incluido</p>
                          <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                            {details.features.map((feature, i) => (
                              <li key={i}>• {feature}</li>
                            ))}
                          </ul>
                          {!isCurrent && exceedsLimits && (
                            <div className="mt-3 pt-3 border-t border-amber-500/30">
                              <p className="text-xs text-amber-600 dark:text-amber-400">
                                {exceedsOrgLimit && <span className="block">Eliminá {orgExcess} org{orgExcess > 1 ? 's' : ''} para cambiar</span>}
                                {exceedsMemberLimit && <span className="block">Reducí {memberExcess} miembro{memberExcess > 1 ? 's' : ''} para cambiar</span>}
                              </p>
                            </div>
                          )}
                          {!isCurrent && !exceedsLimits && (
                            <p className="mt-3 text-xs text-primary font-medium">
                              Clic para cambiar →
                            </p>
                          )}
                        </button>
                      );
                    })}
                    
                    <div className="p-4 rounded-xl border-2 border-dashed border-muted-foreground/30 text-left bg-gradient-to-br from-primary/5 to-accent/5">
                      <h4 className="font-semibold text-lg">Personalizado</h4>
                      <p className="text-2xl font-bold mt-1 text-muted-foreground">
                        A medida
                      </p>
                      <p className="mt-3 text-sm text-muted-foreground">
                        ¿Necesitás más organizaciones o miembros? Armamos un plan a tu medida.
                      </p>
                      <a 
                        href="mailto:contacto@aikestar.com?subject=Consulta%20Plan%20Personalizado"
                        className="mt-3 inline-block text-xs text-primary font-medium hover:underline"
                        data-testid="link-contact-custom-plan"
                      >
                        Contactanos →
                      </a>
                    </div>
                  </div>
                </div>
                
                {user?.planType && (
                  <div className="border-t pt-6 mt-6">
                    {isPendingCancellation ? (
                      <div className="p-4 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/20">
                        <div className="flex items-start gap-3">
                          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                          <div className="flex-1">
                            <h4 className="font-medium text-amber-900 dark:text-amber-100">Suscripción Cancelada</h4>
                            <p className="text-sm text-amber-700 dark:text-amber-300 mt-1 mb-3">
                              {accessEndsAtFormatted
                                ? <>Tu suscripción está programada para cancelarse. Seguirás teniendo acceso hasta el <strong>{accessEndsAtFormatted}</strong>. Después, tus datos se conservarán por 60 días. Podés reactivar en cualquier momento.</>
                                : <>Tu suscripción está programada para cancelarse. Después, tus datos se conservarán por 60 días. Podés reactivarla en cualquier momento.</>
                              }
                            </p>
                            <Button 
                              variant="default" 
                              size="sm"
                              onClick={handleResumeSubscription}
                              disabled={isResumingSubscription}
                              data-testid="button-resume-subscription"
                            >
                              {isResumingSubscription ? 'Reactivando...' : 'Reactivar suscripción'}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-4 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/20">
                        <div className="flex items-start gap-3">
                          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                          <div className="flex-1">
                            <h4 className="font-medium text-amber-900 dark:text-amber-100">Cancelar Suscripción</h4>
                            <p className="text-sm text-amber-700 dark:text-amber-300 mt-1 mb-3">
                              Si cancelás tu suscripción, seguirás teniendo acceso hasta el final del período de facturación. Después, tu cuenta quedará inactiva pero tus datos se conservarán por 60 días. Durante ese tiempo podés volver a suscribirte y recuperar todo. Pasados los 60 días, tu cuenta y datos serán eliminados permanentemente.
                            </p>
                            <Button 
                              variant="outline" 
                              size="sm"
                              className="border-amber-500 text-amber-700 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-500/20"
                              onClick={() => setCancelSubscriptionDialogOpen(true)}
                              data-testid="button-open-cancel-subscription"
                            >
                              Cancelar suscripción
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                  </>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="team" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-team">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <Users className="h-5 w-5 text-blue-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Equipo</p>
                  <p className="text-sm text-muted-foreground font-normal">Gestiona los miembros de tu organización</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="pt-2">
                <TeamPage embedded />
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="organizations" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-organizations">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <Building className="h-5 w-5 text-blue-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">
                    {isPersonalAccount && (planLimits?.limits.maxOrgs ?? 1) === 1 ? 'Mis Finanzas' : 'Organizaciones'}
                  </p>
                  <p className="text-sm text-muted-foreground font-normal">
                    {isPersonalAccount && (planLimits?.limits.maxOrgs ?? 1) === 1 
                      ? 'Tu espacio personal de finanzas' 
                      : `${organizations.length} organización(es) configurada(s)`}
                  </p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="space-y-4 pt-2">
                {organizations.map((org: any) => (
                  <div 
                    key={org.id} 
                    className={`flex items-center justify-between p-4 rounded-lg border ${
                      org.id === organization?.id ? 'border-primary bg-primary/5' : 'border-border'
                    }`}
                    data-testid={`org-card-${org.id}`}
                  >
                    <div className="flex items-center gap-3 flex-1">
                      <button
                        type="button"
                        onClick={() => org.type !== 'personal' && handleOpenBrandPicker(org)}
                        className={`relative group ${org.type !== 'personal' ? 'cursor-pointer' : 'cursor-default'}`}
                        disabled={org.type === 'personal'}
                        data-testid={`button-change-logo-${org.id}`}
                      >
                        {org.logoUrl ? (
                          <img 
                            src={org.logoUrl} 
                            alt={org.name} 
                            className="h-10 w-10 rounded-lg object-cover"
                          />
                        ) : org.iconKey ? (
                          (() => {
                            const IconComponent = getIconByKey(org.iconKey);
                            return (
                              <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
                                <IconComponent className="h-5 w-5" />
                              </div>
                            );
                          })()
                        ) : (
                          <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${
                            org.type === 'personal' 
                              ? 'bg-blue-500/10 text-blue-500' 
                              : 'bg-primary/10 text-primary'
                          }`}>
                            {org.type === 'personal' ? <User className="h-5 w-5" /> : <Building className="h-5 w-5" />}
                          </div>
                        )}
                        {org.type !== 'personal' && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity">
                            <Pencil className="h-4 w-4 text-white" />
                          </div>
                        )}
                      </button>
                      
                      {editingOrgId === org.id ? (
                        <div className="flex items-center gap-2 flex-1">
                          <Input
                            value={editingOrgName}
                            onChange={(e) => setEditingOrgName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveOrgName(org.id);
                              if (e.key === 'Escape') handleCancelEdit();
                            }}
                            className="max-w-xs"
                            autoFocus
                            data-testid={`input-edit-org-${org.id}`}
                          />
                          <Button 
                            size="icon" 
                            variant="ghost" 
                            onClick={() => handleSaveOrgName(org.id)}
                            disabled={updateOrgMutation.isPending}
                            data-testid={`button-save-org-${org.id}`}
                          >
                            <Check className="h-4 w-4 text-green-500" />
                          </Button>
                          <Button 
                            size="icon" 
                            variant="ghost" 
                            onClick={handleCancelEdit}
                            data-testid={`button-cancel-edit-${org.id}`}
                          >
                            <X className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </div>
                      ) : (
                        <div>
                          <p className="font-medium">{org.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {org.type === 'personal' ? 'Finanzas personales' : 'Organización'}
                            {org.id === organization?.id && ' • Activa'}
                          </p>
                          {org.type !== 'personal' && org.membershipRole === 'owner' && (
                            <button
                              type="button"
                              onClick={() => handleOpenBrandPicker(org)}
                              className="text-xs text-primary hover:underline mt-0.5"
                              data-testid={`button-edit-brand-hint-${org.id}`}
                            >
                              Logo y datos de contacto del PDF
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {editingOrgId !== org.id && (
                      <div className="flex items-center gap-2">
                        {org.membershipRole === 'owner' && (
                          <>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleEditOrg(org)}
                              data-testid={`button-edit-org-${org.id}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            {org.type !== 'personal' && organizations.length > 1 && (
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => handleDeleteClick(org)}
                                className="text-destructive hover:text-destructive"
                                data-testid={`button-delete-org-${org.id}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </>
                        )}
                        {org.membershipRole !== 'owner' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const displayName = org.type === 'personal' ? (org.ownerFirstName ? `Personal de ${org.ownerFirstName}` : org.name) : org.name;
                              setOrgToLeave({ id: org.id, name: displayName });
                              setLeaveTeamDialogOpen(true);
                            }}
                            className="text-orange-600 border-orange-300 hover:bg-orange-50 hover:text-orange-700"
                            data-testid={`button-leave-org-${org.id}`}
                          >
                            Abandonar
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                ))}

                {organizations.length === 0 && (
                  <p className="text-muted-foreground text-center py-8">
                    No tienes organizaciones configuradas.
                  </p>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="categories" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-categories">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cyan-500/10">
                  <Tags className="h-5 w-5 text-cyan-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Conceptos / Categorías</p>
                  <p className="text-sm text-muted-foreground font-normal">Administrá las categorías de ingresos y egresos</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="space-y-6 pt-2">
                <div className="p-4 rounded-xl border bg-muted/30">
                  <h4 className="font-medium mb-3 flex items-center gap-2">
                    <Plus className="h-4 w-4" /> Agregar nueva categoría
                  </h4>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Input
                      placeholder="Nombre de la categoría"
                      value={newCategoryName}
                      onChange={(e) => setNewCategoryName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleCreateCategory()}
                      disabled={isCreatingCategory}
                      className="flex-1"
                      data-testid="input-new-category-name"
                    />
                    <div className="flex gap-2">
                      <Button
                        variant={newCategoryType === 'income' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setNewCategoryType('income')}
                        className="gap-1"
                        data-testid="button-type-income"
                      >
                        <TrendingUp className="h-4 w-4" /> Ingreso
                      </Button>
                      <Button
                        variant={newCategoryType === 'expense' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setNewCategoryType('expense')}
                        className="gap-1"
                        data-testid="button-type-expense"
                      >
                        <TrendingDown className="h-4 w-4" /> Egreso
                      </Button>
                    </div>
                    {newCategoryType === 'expense' && (
                      <div className="flex gap-2">
                        <Button
                          variant={newCategorySubtype === 'cost' ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setNewCategorySubtype('cost')}
                          className="gap-1 text-xs"
                          data-testid="button-subtype-cost"
                        >
                          Costo
                        </Button>
                        <Button
                          variant={newCategorySubtype === 'expense' ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setNewCategorySubtype('expense')}
                          className="gap-1 text-xs"
                          data-testid="button-subtype-expense"
                        >
                          Gasto
                        </Button>
                      </div>
                    )}
                    <Button
                      onClick={handleCreateCategory}
                      disabled={isCreatingCategory || !newCategoryName.trim()}
                      size="sm"
                      data-testid="button-create-category"
                    >
                      Agregar
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <h4 className="font-medium flex items-center gap-2 text-green-600 dark:text-green-400">
                      <TrendingUp className="h-4 w-4" /> Ingresos ({incomeCategories.length})
                    </h4>
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {incomeCategories.map((cat) => (
                        <div key={cat.id} className="flex items-center justify-between p-2 rounded-lg bg-green-500/5 border border-green-500/20">
                          {editingCategoryId === cat.id ? (
                            <div className="flex-1 flex items-center gap-2">
                              <Input
                                value={editingCategoryName}
                                onChange={(e) => setEditingCategoryName(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleUpdateCategory(cat.id)}
                                className="h-8 text-sm"
                                autoFocus
                                data-testid={`input-edit-category-${cat.id}`}
                              />
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleUpdateCategory(cat.id)}>
                                <Check className="h-4 w-4 text-green-500" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingCategoryId(null)}>
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : (
                            <>
                              <span className="text-sm">{cat.name}</span>
                              <div className="flex items-center gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  onClick={() => { setEditingCategoryId(cat.id); setEditingCategoryName(cat.name); }}
                                  data-testid={`button-edit-category-${cat.id}`}
                                >
                                  <Pencil className="h-3 w-3" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 text-destructive"
                                  onClick={() => handleDeleteCategory(cat.id, cat.name, 'income')}
                                  data-testid={`button-delete-category-${cat.id}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                      {incomeCategories.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-4">No hay categorías de ingresos</p>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-medium flex items-center gap-2 text-red-600 dark:text-red-400">
                      <TrendingDown className="h-4 w-4" /> Egresos ({expenseCategories.length})
                    </h4>
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {expenseCategories.map((cat) => (
                        <div key={cat.id} className="flex items-center justify-between p-2 rounded-lg bg-red-500/5 border border-red-500/20">
                          {editingCategoryId === cat.id ? (
                            <div className="flex-1 flex items-center gap-2">
                              <Input
                                value={editingCategoryName}
                                onChange={(e) => setEditingCategoryName(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleUpdateCategory(cat.id)}
                                className="h-8 text-sm"
                                autoFocus
                                data-testid={`input-edit-category-${cat.id}`}
                              />
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleUpdateCategory(cat.id)}>
                                <Check className="h-4 w-4 text-green-500" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingCategoryId(null)}>
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : (
                            <>
                              <div className="flex items-center gap-2">
                                <span className="text-sm">{cat.name}</span>
                                <div
                                  className="inline-flex items-center rounded-full border border-border overflow-hidden cursor-pointer select-none"
                                  data-testid={`toggle-subtype-${cat.id}`}
                                >
                                  <button
                                    type="button"
                                    className={`text-[10px] px-2 py-0.5 font-medium transition-colors ${
                                      cat.expenseSubtype === 'cost'
                                        ? 'bg-orange-500 text-white'
                                        : 'bg-transparent text-muted-foreground hover:bg-muted'
                                    }`}
                                    onClick={() => {
                                      if (cat.expenseSubtype === 'cost') return;
                                      setPendingSubtypeChange({ categoryId: cat.id, categoryName: cat.name, currentSubtype: cat.expenseSubtype || 'expense', newSubtype: 'cost' });
                                    }}
                                    data-testid={`btn-cost-${cat.id}`}
                                  >
                                    Costo
                                  </button>
                                  <button
                                    type="button"
                                    className={`text-[10px] px-2 py-0.5 font-medium transition-colors ${
                                      cat.expenseSubtype !== 'cost'
                                        ? 'bg-purple-500 text-white'
                                        : 'bg-transparent text-muted-foreground hover:bg-muted'
                                    }`}
                                    onClick={() => {
                                      if (cat.expenseSubtype !== 'cost') return;
                                      setPendingSubtypeChange({ categoryId: cat.id, categoryName: cat.name, currentSubtype: cat.expenseSubtype || 'expense', newSubtype: 'expense' });
                                    }}
                                    data-testid={`btn-expense-${cat.id}`}
                                  >
                                    Gasto
                                  </button>
                                </div>
                              </div>
                              <div className="flex items-center gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  onClick={() => { setEditingCategoryId(cat.id); setEditingCategoryName(cat.name); }}
                                  data-testid={`button-edit-category-${cat.id}`}
                                >
                                  <Pencil className="h-3 w-3" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7 text-destructive"
                                  onClick={() => handleDeleteCategory(cat.id, cat.name, 'expense')}
                                  data-testid={`button-delete-category-${cat.id}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                      {expenseCategories.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-4">No hay categorías de egresos</p>
                      )}
                    </div>
                  </div>
                </div>

                {archivedCategories.length > 0 && (
                  <div className="space-y-2 mt-6" data-testid="archived-categories-section">
                    <h4 className="font-medium flex items-center gap-2 text-muted-foreground">
                      <FolderArchive className="h-4 w-4" /> Archivadas ({archivedCategories.length})
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      Estas categorías se conservaron porque tenían movimientos asociados. Podés restaurarlas o, si sos propietario/administrador, eliminarlas definitivamente.
                    </p>
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {archivedCategories.map((cat) => (
                        <div
                          key={cat.id}
                          className="flex items-center justify-between p-2 rounded-lg bg-muted/30 border border-border opacity-80"
                          data-testid={`row-archived-category-${cat.id}`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-sm">{cat.name}</span>
                            <Badge variant="outline" className="text-[10px]">
                              {cat.type === 'income' ? 'Ingreso' : 'Egreso'}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => unarchiveCategoryMutation.mutate(cat.id)}
                              disabled={unarchiveCategoryMutation.isPending}
                              data-testid={`button-restore-category-${cat.id}`}
                            >
                              <RotateCcw className="h-3 w-3 mr-1" /> Restaurar
                            </Button>
                            {isOwnerOrAdmin && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-destructive"
                                onClick={() => {
                                  if (window.confirm(`¿Eliminar definitivamente "${cat.name}"? Esta acción no se puede deshacer.`)) {
                                    hardDeleteCategoryMutation.mutate(cat.id);
                                  }
                                }}
                                disabled={hardDeleteCategoryMutation.isPending}
                                data-testid={`button-hard-delete-category-${cat.id}`}
                              >
                                <Trash2 className="h-3 w-3 mr-1" /> Eliminar
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="dashboard-prefs" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-dashboard-prefs">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cyan-500/10">
                  <LayoutDashboard className="h-5 w-5 text-cyan-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Preferencias del Dashboard</p>
                  <p className="text-sm text-muted-foreground font-normal">Valores por defecto para cargar movimientos más rápido</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="space-y-6 pt-2">
                <p className="text-sm text-muted-foreground">
                  Configurá valores por defecto para cuando cargás movimientos desde el dashboard. Estos valores se precargan automáticamente en el formulario, pero siempre podés cambiarlos en cada movimiento.
                </p>

                {organizations.length > 1 && (
                  <div className="space-y-2">
                    <Label htmlFor="dash-org" data-testid="label-dash-org">Organización</Label>
                    <Select value={dashSelectedOrgId} onValueChange={setDashSelectedOrgId} data-testid="select-dash-org">
                      <SelectTrigger id="dash-org" data-testid="trigger-dash-org">
                        <SelectValue placeholder="Seleccioná una organización" />
                      </SelectTrigger>
                      <SelectContent>
                        {organizations.map((org: { id: string; name: string }) => (
                          <SelectItem key={org.id} value={org.id} data-testid={`option-dash-org-${org.id}`}>
                            <div className="flex items-center gap-2">
                              <Building className="h-3.5 w-3.5 text-muted-foreground" />
                              {org.name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Cada organización tiene sus propias preferencias</p>
                  </div>
                )}

                {organizations.length === 1 && organization && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50 border border-border/50">
                    <Building className="h-4 w-4 text-muted-foreground shrink-0" />
                    <p className="text-sm text-muted-foreground">
                      Preferencias para <span className="font-medium text-foreground">{organization.name}</span>
                    </p>
                  </div>
                )}

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="dash-account" data-testid="label-dash-account">Cuenta preferida</Label>
                    <Select value={dashAccountId || 'none'} onValueChange={(v) => setDashAccountId(v === 'none' ? '' : v)} data-testid="select-dash-account">
                      <SelectTrigger id="dash-account" data-testid="trigger-dash-account">
                        <SelectValue placeholder="Sin preferencia" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Sin preferencia</SelectItem>
                        {dashAccountsList.map(acc => (
                          <SelectItem key={acc.id} value={acc.id} data-testid={`option-dash-account-${acc.id}`}>
                            {acc.name} ({acc.currency})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">La cuenta que se preselecciona al cargar un movimiento</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="dash-expense-cat" data-testid="label-dash-expense-cat">Categoría para gastos</Label>
                    <Select value={dashExpenseCategory || 'none'} onValueChange={(v) => setDashExpenseCategory(v === 'none' ? '' : v)} data-testid="select-dash-expense-cat">
                      <SelectTrigger id="dash-expense-cat" data-testid="trigger-dash-expense-cat">
                        <SelectValue placeholder="Sin preferencia" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Sin preferencia</SelectItem>
                        {dashExpenseCats.map(cat => (
                          <SelectItem key={cat.id} value={cat.name} data-testid={`option-dash-expense-cat-${cat.id}`}>
                            {cat.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="dash-income-cat" data-testid="label-dash-income-cat">Categoría para ingresos</Label>
                    <Select value={dashIncomeCategory || 'none'} onValueChange={(v) => setDashIncomeCategory(v === 'none' ? '' : v)} data-testid="select-dash-income-cat">
                      <SelectTrigger id="dash-income-cat" data-testid="trigger-dash-income-cat">
                        <SelectValue placeholder="Sin preferencia" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Sin preferencia</SelectItem>
                        {dashIncomeCats.map(cat => (
                          <SelectItem key={cat.id} value={cat.name} data-testid={`option-dash-income-cat-${cat.id}`}>
                            {cat.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-3">
                    <Label data-testid="label-dash-invoice">Factura por defecto</Label>
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={dashHasInvoice === true}
                        onCheckedChange={(checked) => setDashHasInvoice(checked ? true : false)}
                        data-testid="switch-dash-invoice"
                      />
                      <span className="text-sm text-muted-foreground">
                        {dashHasInvoice === null ? 'Sin preferencia (por defecto: sin factura)' : dashHasInvoice ? 'Siempre con factura' : 'Siempre sin factura'}
                      </span>
                    </div>
                    {dashHasInvoice !== null && (
                      <Button variant="ghost" size="sm" className="text-xs h-7 px-2" onClick={() => setDashHasInvoice(null)} data-testid="button-dash-invoice-reset">
                        Quitar preferencia
                      </Button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <Button onClick={handleSaveDashPrefs} disabled={isSavingDashPrefs || !dashSelectedOrgId} data-testid="button-save-dash-prefs">
                    {isSavingDashPrefs ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                    Guardar preferencias
                  </Button>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="whatsapp" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-whatsapp">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <Smartphone className="h-5 w-5 text-green-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">WhatsApp</p>
                  <p className="text-sm text-muted-foreground font-normal">Vinculá tu número y configurá el bot para cargar movimientos</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="space-y-6 pt-2">
                <div className="p-4 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 rounded-lg border border-green-200 dark:border-green-700">
                  <div className="flex items-start gap-3">
                    <div className="text-2xl">📱</div>
                    <div>
                      <p className="font-semibold text-green-800 dark:text-green-200 mb-2">¿Cómo funciona?</p>
                      <ol className="text-sm text-green-700 dark:text-green-300 space-y-1 list-decimal list-inside">
                        <li>Guardá este número en tus contactos: <span className="font-bold" data-testid="text-bot-number-help">{botDisplayNumber}</span></li>
                        <li>Mandale "Hola" al bot para autorizarlo a contestarte</li>
                        <li>Vinculá tu número desde el botón de abajo</li>
                        <li>Pegá el código de 6 dígitos que llega por WhatsApp</li>
                      </ol>
                      <p className="text-xs text-green-600 dark:text-green-400 mt-2">
                        Ejemplos: "gasté 5000 en almuerzo", "cobré 10000 de Juan", "cuánto gasté este mes"
                      </p>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <MessageCircle className="h-5 w-5 text-green-600" />
                    <h4 className="font-medium">Tu número de WhatsApp</h4>
                  </div>
                  {user?.phoneNumber && !isEditingPhone ? (
                    <div className="space-y-3 max-w-md">
                      <div
                        className={`flex items-center justify-between p-3 rounded-lg border ${
                          user.phoneVerified
                            ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/20'
                            : 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/20'
                        }`}
                        data-testid={user.phoneVerified ? 'status-phone-verified' : 'status-phone-unverified'}
                      >
                        <div className="flex items-center gap-3">
                          {user.phoneVerified ? (
                            <CheckCircle className="h-5 w-5 text-green-600" />
                          ) : (
                            <AlertCircle className="h-5 w-5 text-amber-600" />
                          )}
                          <div className="flex flex-col gap-1">
                            <p className={`font-medium ${user.phoneVerified ? 'text-green-900 dark:text-green-100' : 'text-amber-900 dark:text-amber-100'}`}>
                              {user.phoneNumber}
                            </p>
                            {/* Task #219: replace the plain status text with a real
                                Badge for the unverified case so the "still needs
                                action" state is unmissable. The verified case
                                keeps the lightweight inline label. */}
                            {user.phoneVerified ? (
                              <p className="text-xs text-green-700 dark:text-green-300">
                                ✓ Verificado
                              </p>
                            ) : (
                              <Badge
                                variant="outline"
                                className="self-start bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-600 text-[10px] uppercase tracking-wide font-semibold"
                                data-testid="badge-phone-verify-pending"
                              >
                                Pendiente de verificar
                              </Badge>
                            )}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            // Restart at step 1 even when re-linking: the new
                            // phone may not have greeted the bot.
                            setPhoneNumber('');
                            setVerificationCode('');
                            setPendingPhone(null);
                            setPendingDisplayPhone(null);
                            setBotGreeted(false);
                            setShowNotReceivedHint(false);
                            setPhoneStep('greet-bot');
                            setIsEditingPhone(true);
                          }}
                          data-testid="button-edit-phone"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </div>
                      <Button 
                        variant="outline" 
                        size="sm"
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={handleDeletePhone}
                        disabled={isDeletingPhone}
                        data-testid="button-delete-phone"
                      >
                        {isDeletingPhone ? 'Desvinculando...' : 'Desvincular número'}
                      </Button>
                    </div>
                  ) : isEditingPhone ? (
                    <div className="space-y-4 max-w-md" data-testid="region-phone-wizard">
                      {/* Step indicator: greet-bot → enter-phone → enter-code. */}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="text-phone-step-indicator">
                        {([
                          { key: 'greet-bot', label: 'Saludá al bot' },
                          { key: 'enter-phone', label: 'Tu número' },
                          { key: 'enter-code', label: 'Código' },
                        ] as const).map((s, idx) => {
                          const order: Record<typeof phoneStep, number> = {
                            'greet-bot': 0,
                            'enter-phone': 1,
                            'enter-code': 2,
                          };
                          const active = phoneStep === s.key;
                          const done = order[phoneStep] > idx;
                          return (
                            <div key={s.key} className="flex items-center gap-2">
                              <div
                                className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                                  active
                                    ? 'bg-green-600 text-white'
                                    : done
                                    ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                                    : 'bg-muted text-muted-foreground'
                                }`}
                                data-testid={`badge-step-${s.key}${active ? '-active' : done ? '-done' : ''}`}
                              >
                                {done ? '✓' : idx + 1}
                              </div>
                              <span className={active ? 'text-foreground font-medium' : ''}>{s.label}</span>
                              {idx < 2 && <span className="text-muted-foreground">›</span>}
                            </div>
                          );
                        })}
                      </div>

                      {phoneStep === 'greet-bot' ? (
                        <div className="space-y-3" data-testid="region-step-greet-bot">
                          <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3">
                            <p className="text-sm text-amber-900 dark:text-amber-100 font-medium mb-1">
                              Antes de continuar, escribile al bot
                            </p>
                            <p className="text-xs text-amber-800 dark:text-amber-200">
                              Abrí WhatsApp y mandale "Hola" al número del bot. Después volvé acá y tocá Continuar.
                            </p>
                          </div>
                          <div className="space-y-2">
                            <Label>Número del bot de Aikestar</Label>
                            <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
                              <MessageCircle className="h-4 w-4 text-green-600" />
                              <span className="font-mono text-sm font-medium" data-testid="text-bot-number">{botDisplayNumber}</span>
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              Guardalo en tus contactos (te recomendamos como "Aike Aikestar") para que sea fácil encontrarlo después.
                            </p>
                          </div>
                          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-green-600"
                              checked={botGreeted}
                              onChange={(e) => setBotGreeted(e.target.checked)}
                              data-testid="checkbox-bot-greeted"
                            />
                            <span>Ya le escribí "Hola" al bot</span>
                          </label>
                          <div className="flex gap-2">
                            <Button
                              onClick={() => setPhoneStep('enter-phone')}
                              disabled={!botGreeted}
                              data-testid="button-continue-to-phone"
                            >
                              Continuar
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={handleCancelVerification}
                              data-testid="button-cancel-phone"
                            >
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      ) : phoneStep === 'enter-phone' ? (
                        <div className="space-y-3" data-testid="region-step-enter-phone">
                          <div className="space-y-2">
                            <Label>Número de WhatsApp</Label>
                            <CountryPhoneInput
                              value={phoneNumber}
                              onChange={(val) => setPhoneNumber(val)}
                              disabled={isSavingPhone}
                              showPreview
                            />
                            {/* Task #221: hint shown only when the field was
                                pre-filled from the signup form (pendingPhoneNumber).
                                Lets the user know the value isn't saved yet
                                and they can change it. */}
                            {user?.pendingPhoneNumber && phoneNumber === user.pendingPhoneNumber ? (
                              <p
                                className="text-xs text-muted-foreground"
                                data-testid="text-prefilled-from-signup"
                              >
                                Pre-cargamos el número que ingresaste al crear tu cuenta. Podés cambiarlo si querés.
                              </p>
                            ) : null}
                            <p className="text-xs text-muted-foreground">
                              Tiene que ser el mismo número desde el que le escribiste "Hola" al bot.
                              Te enviaremos un código de 6 dígitos por WhatsApp.
                            </p>
                          </div>
                          <div className="flex gap-2 flex-wrap">
                            <Button
                              onClick={handleSendCode}
                              disabled={isSavingPhone || !phoneNumber.trim()}
                              data-testid="button-send-code"
                            >
                              {isSavingPhone ? 'Enviando...' : 'Enviar código'}
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() => setPhoneStep('greet-bot')}
                              disabled={isSavingPhone}
                              data-testid="button-back-to-greet"
                            >
                              Atrás
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={handleCancelVerification}
                              data-testid="button-cancel-phone-step"
                            >
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-3" data-testid="region-step-enter-code">
                          <div className="space-y-2">
                            <Label htmlFor="phone-verification-code">Código de verificación</Label>
                            <Input
                              id="phone-verification-code"
                              value={verificationCode}
                              onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                              placeholder="123456"
                              inputMode="numeric"
                              maxLength={6}
                              autoComplete="one-time-code"
                              disabled={isVerifyingCode}
                              data-testid="input-verification-code"
                            />
                            <p className="text-xs text-muted-foreground">
                              Te enviamos un código de 6 dígitos por WhatsApp a <strong>{pendingDisplayPhone}</strong>. Pegalo acá para terminar de vincular el número. Vence en 10 minutos.
                            </p>
                          </div>
                          {showNotReceivedHint && (
                            <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3" data-testid="region-not-received-hint">
                              <p className="text-sm text-amber-900 dark:text-amber-100 font-medium mb-1">¿No te llegó el código?</p>
                              <p className="text-xs text-amber-800 dark:text-amber-200 mb-2">
                                Asegurate de haberle escrito "Hola" al bot ({botDisplayNumber}) desde el mismo número que estás vinculando.
                                Si todavía no lo hiciste, abrí WhatsApp ahora y mandale el saludo — después tocá "Reenviar código".
                              </p>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={handleOpenWhatsappBot}
                                data-testid="button-open-whatsapp-bot-from-hint"
                              >
                                <MessageCircle className="mr-2 h-4 w-4" />
                                Abrir WhatsApp y saludar a Aike
                              </Button>
                            </div>
                          )}
                          <div className="flex gap-2 flex-wrap">
                            <Button
                              onClick={handleVerifyCode}
                              disabled={isVerifyingCode || verificationCode.length !== 6}
                              data-testid="button-verify-code"
                            >
                              {isVerifyingCode ? 'Verificando...' : 'Verificar'}
                            </Button>
                            <Button
                              variant="outline"
                              onClick={handleResendCode}
                              disabled={isSavingPhone || resendCooldownSec > 0}
                              data-testid="button-resend-code"
                            >
                              {resendCooldownSec > 0 ? `Reenviar en ${resendCooldownSec}s` : 'Reenviar código'}
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() => setPhoneStep('enter-phone')}
                              disabled={isVerifyingCode || isSavingPhone}
                              data-testid="button-back-to-phone"
                            >
                              Atrás
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={handleCancelVerification}
                              data-testid="button-cancel-verification"
                            >
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <Button 
                      variant="outline"
                      onClick={() => {
                        setPhoneStep('greet-bot');
                        // Task #221: if the user typed a phone at signup it's
                        // stored in pendingPhoneNumber (informational, never on
                        // users.phoneNumber). Pre-fill the wizard with it as a
                        // suggestion the user can edit or replace.
                        setPhoneNumber(user?.pendingPhoneNumber || '');
                        setVerificationCode('');
                        setPendingPhone(null);
                        setPendingDisplayPhone(null);
                        setBotGreeted(false);
                        setShowNotReceivedHint(false);
                        setIsEditingPhone(true);
                      }}
                      data-testid="button-add-phone"
                    >
                      <Plus className="mr-2 h-4 w-4" /> Vincular número de WhatsApp
                    </Button>
                  )}
                </div>

                {organizations.length > 1 && (
                  <div className="border-t pt-6 mb-6">
                    <div className="flex items-center gap-2 mb-3">
                      <Building className="h-5 w-5 text-green-600" />
                      <h4 className="font-medium">Organización por defecto del bot</h4>
                    </div>
                    <p className="text-sm text-muted-foreground mb-4">
                      El bot de WhatsApp registrará tus movimientos en esta organización por defecto, sin importar cuál tengas abierta en la web. Si mencionás otra organización en un mensaje, el bot la usa solo para esa conversación; tu elección por defecto no cambia.
                    </p>
                    <div className="space-y-2 max-w-md">
                      <Label htmlFor="wa-default-org" data-testid="label-wa-default-org">Organización</Label>
                      <Select
                        value={waDefaultOrg?.organizationId || '__none__'}
                        onValueChange={(v) => handleSaveWaDefaultOrg(v === '__none__' ? null : v)}
                        disabled={isSavingWaDefault}
                        data-testid="select-wa-default-org"
                      >
                        <SelectTrigger id="wa-default-org" data-testid="trigger-wa-default-org">
                          <SelectValue placeholder="Seleccioná una organización" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem
                            value="__none__"
                            data-testid="option-wa-default-org-none"
                          >
                            <div className="flex items-center gap-2 text-muted-foreground">
                              Sin organización por defecto
                            </div>
                          </SelectItem>
                          {organizations.map((org: { id: string; name: string }) => (
                            <SelectItem
                              key={org.id}
                              value={org.id}
                              data-testid={`option-wa-default-org-${org.id}`}
                            >
                              <div className="flex items-center gap-2">
                                <Building className="h-3.5 w-3.5 text-muted-foreground" />
                                {org.name}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Si elegís "Sin organización por defecto", el bot te va a preguntar a cuál registrar cada movimiento cuando no quede claro.
                      </p>
                      {waDefaultOrg?.organizationId && !waDefaultOrg.valid && (
                        <p className="text-xs text-destructive" data-testid="text-wa-default-org-invalid">
                          La organización por defecto ya no es válida. Elegí otra.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                <div className="border-t pt-6">
                  <div className="flex items-center gap-2 mb-3">
                    <Settings className="h-5 w-5 text-green-600" />
                    <h4 className="font-medium">Preferencias del Bot</h4>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">
                    Estos valores se usan por defecto cuando registrás movimientos por WhatsApp, para que no tengas que repetirlos cada vez.
                  </p>

                {organizations.length > 1 && (
                  <div className="space-y-2">
                    <Label htmlFor="wa-org" data-testid="label-wa-org">Organización</Label>
                    <Select value={waSelectedOrgId} onValueChange={setWaSelectedOrgId} data-testid="select-wa-org">
                      <SelectTrigger id="wa-org" data-testid="trigger-wa-org">
                        <SelectValue placeholder="Seleccioná una organización" />
                      </SelectTrigger>
                      <SelectContent>
                        {organizations.map((org: { id: string; name: string }) => (
                          <SelectItem key={org.id} value={org.id} data-testid={`option-wa-org-${org.id}`}>
                            <div className="flex items-center gap-2">
                              <Building className="h-3.5 w-3.5 text-muted-foreground" />
                              {org.name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Cada organización tiene sus propias preferencias de WhatsApp</p>
                  </div>
                )}

                {organizations.length === 1 && organization && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50 border border-border/50">
                    <Building className="h-4 w-4 text-muted-foreground shrink-0" />
                    <p className="text-sm text-muted-foreground">
                      Preferencias para <span className="font-medium text-foreground">{organization.name}</span>
                    </p>
                  </div>
                )}

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="wa-account" data-testid="label-wa-account">Cuenta preferida</Label>
                    <Select value={waAccountId || 'none'} onValueChange={(v) => setWaAccountId(v === 'none' ? '' : v)} data-testid="select-wa-account">
                      <SelectTrigger id="wa-account" data-testid="trigger-wa-account">
                        <SelectValue placeholder="Automática (según patrón)" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Sin preferencia</SelectItem>
                        {waAccountsList.map(acc => (
                          <SelectItem key={acc.id} value={acc.id} data-testid={`option-wa-account-${acc.id}`}>
                            {acc.name} ({acc.currency})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Si no elegís una, el bot selecciona automáticamente según tus movimientos recientes</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="wa-expense-cat" data-testid="label-wa-expense-cat">Categoría para gastos</Label>
                    <Select value={waExpenseCategory || 'none'} onValueChange={(v) => setWaExpenseCategory(v === 'none' ? '' : v)} data-testid="select-wa-expense-cat">
                      <SelectTrigger id="wa-expense-cat" data-testid="trigger-wa-expense-cat">
                        <SelectValue placeholder="Automática (según patrón)" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Sin preferencia</SelectItem>
                        {waExpenseCats.map(cat => (
                          <SelectItem key={cat.id} value={cat.name} data-testid={`option-wa-expense-cat-${cat.id}`}>
                            {cat.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="wa-income-cat" data-testid="label-wa-income-cat">Categoría para ingresos</Label>
                    <Select value={waIncomeCategory || 'none'} onValueChange={(v) => setWaIncomeCategory(v === 'none' ? '' : v)} data-testid="select-wa-income-cat">
                      <SelectTrigger id="wa-income-cat" data-testid="trigger-wa-income-cat">
                        <SelectValue placeholder="Automática (según patrón)" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Sin preferencia</SelectItem>
                        {waIncomeCats.map(cat => (
                          <SelectItem key={cat.id} value={cat.name} data-testid={`option-wa-income-cat-${cat.id}`}>
                            {cat.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-3">
                    <Label data-testid="label-wa-invoice">Factura por defecto</Label>
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={waHasInvoice === true}
                        onCheckedChange={(checked) => setWaHasInvoice(checked ? true : false)}
                        data-testid="switch-wa-invoice"
                      />
                      <span className="text-sm text-muted-foreground">
                        {waHasInvoice === null ? 'Sin preferencia (por defecto: sin factura)' : waHasInvoice ? 'Siempre con factura' : 'Siempre sin factura'}
                      </span>
                    </div>
                    {waHasInvoice !== null && (
                      <Button variant="ghost" size="sm" className="text-xs h-7 px-2" onClick={() => setWaHasInvoice(null)} data-testid="button-wa-invoice-reset">
                        Quitar preferencia
                      </Button>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="wa-org-banner-interval" data-testid="label-wa-org-banner-interval">
                      Recordatorio de organización
                    </Label>
                    <Select value={waOrgBannerInterval} onValueChange={setWaOrgBannerInterval} data-testid="select-wa-org-banner-interval">
                      <SelectTrigger id="wa-org-banner-interval" data-testid="trigger-wa-org-banner-interval">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default" data-testid="option-wa-org-banner-default">Por defecto (cada 6 horas)</SelectItem>
                        <SelectItem value="1" data-testid="option-wa-org-banner-1">Cada 1 hora</SelectItem>
                        <SelectItem value="3" data-testid="option-wa-org-banner-3">Cada 3 horas</SelectItem>
                        <SelectItem value="6" data-testid="option-wa-org-banner-6">Cada 6 horas</SelectItem>
                        <SelectItem value="12" data-testid="option-wa-org-banner-12">Cada 12 horas</SelectItem>
                        <SelectItem value="24" data-testid="option-wa-org-banner-24">Una vez por día</SelectItem>
                        <SelectItem value="never" data-testid="option-wa-org-banner-never">No mostrar nunca</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Cada cuánto el bot vuelve a mostrarte un recordatorio con la organización en la que estás registrando movimientos al iniciar una nueva conversación.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <Button onClick={handleSaveWaPrefs} disabled={isSavingWaPrefs || !waSelectedOrgId} data-testid="button-save-wa-prefs">
                    {isSavingWaPrefs ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                    Guardar preferencias
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    También podés configurarlas desde WhatsApp diciendo "mis preferencias"
                  </p>
                </div>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="faq" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-faq">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-500/10">
                  <HelpCircle className="h-5 w-5 text-amber-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Preguntas Frecuentes</p>
                  <p className="text-sm text-muted-foreground font-normal">Respuestas a dudas comunes</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="space-y-6 pt-2">
                <div className="p-4 rounded-xl bg-gradient-to-r from-cyan-500/10 to-pink-500/10 border border-primary/20">
                  <div className="flex items-center gap-2 mb-3">
                    <MessageCircle className="h-5 w-5 text-primary" />
                    <h4 className="font-semibold">Preguntale a Aike</h4>
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">
                    ¿No encontrás lo que buscás? Preguntame cómo hacer algo en Aikestar.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Ej: ¿Cómo registro una venta?"
                      value={helpQuestion}
                      onChange={(e) => setHelpQuestion(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAskHelp()}
                      disabled={isAskingHelp}
                      data-testid="input-help-question"
                    />
                    <Button 
                      onClick={handleAskHelp} 
                      disabled={isAskingHelp || !helpQuestion.trim()}
                      size="icon"
                      data-testid="button-ask-help"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>
                  {helpAnswer && (
                    <div className="mt-4 p-3 rounded-lg bg-card border text-sm">
                      <p className="text-muted-foreground whitespace-pre-wrap">{helpAnswer}</p>
                    </div>
                  )}
                  {isAskingHelp && (
                    <div className="mt-4 p-3 rounded-lg bg-card border text-sm text-muted-foreground animate-pulse">
                      Pensando...
                    </div>
                  )}
                </div>

                <Accordion type="multiple" className="space-y-3">
                  {FAQ_CATEGORIES.map((cat, catIndex) => {
                    const IconMap: { [key: string]: any } = {
                      CreditCard, ArrowLeftRight, Users, Truck, Package, BarChart3, Sparkles, UserPlus, Settings, Repeat, Tags, MessageCircle, TrendingUp, CalendarClock, Calendar, BookOpen, Warehouse, LayoutDashboard, HeartPulse, Download, Bell, ClipboardList, Crown
                    };
                    const Icon = IconMap[cat.icon] || HelpCircle;
                    return (
                      <AccordionItem 
                        key={catIndex} 
                        value={`cat-${catIndex}`} 
                        className="border rounded-lg px-4 bg-muted/30"
                      >
                        <AccordionTrigger 
                          className="text-sm font-semibold hover:no-underline py-3"
                          data-testid={`accordion-faq-category-${catIndex}`}
                        >
                          <div className="flex items-center gap-2">
                            <Icon className="h-4 w-4 text-primary" />
                            {cat.category}
                          </div>
                        </AccordionTrigger>
                        <AccordionContent className="pb-3">
                          <div className="space-y-2 pl-6">
                            {cat.items.map((faq, faqIndex) => {
                              // Rewrite the fallback bot number with the live
                              // backend value so FAQ copy never drifts.
                              const answer = botInfo?.display && botInfo.display !== BOT_DISPLAY_FALLBACK
                                ? faq.answer.split(BOT_DISPLAY_FALLBACK).join(botInfo.display)
                                : faq.answer;
                              return (
                                <div key={faqIndex} className="border-l-2 border-primary/20 pl-3 py-2">
                                  <p className="text-sm font-medium">{faq.question}</p>
                                  <p className="text-xs text-muted-foreground mt-1">{answer}</p>
                                </div>
                              );
                            })}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    );
                  })}
                </Accordion>
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="privacy" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-privacy">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <Shield className="h-5 w-5 text-green-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Políticas de Privacidad</p>
                  <p className="text-sm text-muted-foreground font-normal">Seguridad y protección de datos</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <PrivacyContent />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="terms" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-terms">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-indigo-500/10">
                  <FileText className="h-5 w-5 text-indigo-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Términos y Condiciones</p>
                  <p className="text-sm text-muted-foreground font-normal">Condiciones generales de contratación</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="pt-2">
                <TermsContent />
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="support" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-support">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-pink-500/10">
                  <Headphones className="h-5 w-5 text-pink-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Contacto y Soporte</p>
                  <p className="text-sm text-muted-foreground font-normal">Envianos tu consulta o reportá un error</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="space-y-6 pt-2">
                <div className="flex items-start gap-3 p-4 rounded-lg bg-pink-50 dark:bg-pink-500/10 border border-pink-200 dark:border-pink-500/20">
                  <Mail className="h-5 w-5 text-pink-600 dark:text-pink-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <h4 className="font-medium text-pink-900 dark:text-pink-100">Estamos para ayudarte</h4>
                    <p className="text-sm text-pink-700 dark:text-pink-300 mt-1">
                      Si tenés alguna sugerencia, consulta o necesidad respecto a Aikestar, escribinos. 
                      Tu opinión nos ayuda a mejorar constantemente.
                    </p>
                  </div>
                </div>

                {supportSent ? (
                  <div className="flex items-center gap-3 p-4 rounded-lg bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/20">
                    <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
                    <p className="text-sm text-green-700 dark:text-green-300 font-medium">
                      ¡Mensaje enviado! Te responderemos a tu email pronto.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="support-subject">Asunto</Label>
                      <Input
                        id="support-subject"
                        placeholder="Ej: Error al cargar movimientos / Sugerencia de mejora"
                        value={supportSubject}
                        onChange={(e) => setSupportSubject(e.target.value)}
                        disabled={isSendingSupport}
                        data-testid="input-support-subject"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="support-contact-email">
                        Email de contacto <span className="text-muted-foreground font-normal">(opcional)</span>
                      </Label>
                      <Input
                        id="support-contact-email"
                        type="email"
                        placeholder={user?.email || "Tu email de contacto alternativo"}
                        value={supportContactEmail}
                        onChange={(e) => setSupportContactEmail(e.target.value)}
                        disabled={isSendingSupport}
                        data-testid="input-support-contact-email"
                      />
                      <p className="text-xs text-muted-foreground">
                        Si no completás este campo, responderemos al email de tu cuenta ({user?.email})
                      </p>
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="support-message">Mensaje</Label>
                      <textarea
                        id="support-message"
                        className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                        placeholder="Describí tu consulta, problema o sugerencia en detalle..."
                        value={supportMessage}
                        onChange={(e) => setSupportMessage(e.target.value)}
                        disabled={isSendingSupport}
                        data-testid="input-support-message"
                      />
                    </div>
                    
                    <Button 
                      onClick={handleSendSupport}
                      disabled={isSendingSupport || !supportSubject.trim() || supportMessage.trim().length < 10}
                      className="w-full sm:w-auto"
                      data-testid="button-send-support"
                    >
                      {isSendingSupport ? (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                          Enviando...
                        </>
                      ) : (
                        <>
                          <Send className="h-4 w-4 mr-2" />
                          Enviar mensaje
                        </>
                      )}
                    </Button>
                  </div>
                )}

                <div className="border-t pt-4 space-y-3">
                  <p className="text-sm text-muted-foreground font-medium">También podés contactarnos:</p>
                  <div className="flex flex-col gap-2.5">
                    <a 
                      href="mailto:ai@aikestar.com" 
                      className="flex items-center gap-2.5 text-sm text-primary hover:underline font-medium"
                      data-testid="link-email-support"
                    >
                      <Mail className="h-4 w-4 shrink-0" />
                      ai@aikestar.com
                    </a>
                    <a 
                      href="mailto:ai@aikestar.com" 
                      className="flex items-center gap-2.5 text-sm text-primary hover:underline font-medium"
                      data-testid="link-email-support-net"
                    >
                      <Mail className="h-4 w-4 shrink-0" />
                      ai@aikestar.com
                    </a>
                    <a 
                      href="https://wa.me/541153874843" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="flex items-center gap-2.5 text-sm text-green-600 hover:text-green-700 hover:underline font-medium"
                      data-testid="link-whatsapp-support"
                    >
                      <MessageCircle className="h-4 w-4 shrink-0" />
                      Por WhatsApp al +54 11 5387-4843
                    </a>
                  </div>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="integrations" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-integrations">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Store className="h-5 w-5 text-primary" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Integraciones</p>
                  <p className="text-sm text-muted-foreground font-normal">Conectá tu tienda online (Tiendanube)</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="pt-2">
                <TiendanubeIntegration />
              </div>
            </AccordionContent>
          </AccordionItem>

        </Accordion>
      </div>

      <div className="mt-4 space-y-4 max-w-5xl">
        <Accordion type="multiple" className="space-y-4">
          {FEATURE_FLAGS.INVOICING_ENABLED && !isPersonalBasic && (
          <AccordionItem value="invoicing" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-invoicing">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-pink-500/10">
                  <FileText className="h-5 w-5 text-pink-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Facturador (ARCA)</p>
                  <p className="text-sm text-muted-foreground font-normal">Activá la emisión de facturas electrónicas ante ARCA</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="pt-2">
                <FacturadorSection canEdit={!!membership && (membership.role === 'owner' || membership.role === 'admin')} />
              </div>
            </AccordionContent>
          </AccordionItem>
          )}
          {FEATURE_FLAGS.INVOICING_ENABLED && !isPersonalBasic && (
          <AccordionItem value="taxes" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-taxes">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cyan-500/10">
                  <FileText className="h-5 w-5 text-cyan-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Condiciones impositivas</p>
                  <p className="text-sm text-muted-foreground font-normal">IVA, Ingresos Brutos, Ganancias y otros tributos</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="pt-2">
                <TaxProfileSection canEdit={!!membership && (membership.role === 'owner' || membership.role === 'admin')} />
              </div>
            </AccordionContent>
          </AccordionItem>
          )}
          {membership && (membership.role === 'owner' || membership.role === 'admin') && (
          <AccordionItem value="profitability-codes" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-profitability-codes">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-pink-500/10">
                  <Tags className="h-5 w-5 text-pink-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Códigos de Análisis de Rentabilidad</p>
                  <p className="text-sm text-muted-foreground font-normal">Etiquetá movimientos y productos para ver rentabilidad cruzada en Reportes</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="pt-2">
                <ProfitabilityCodesSection canEdit={!!membership && (membership.role === 'owner' || membership.role === 'admin')} />
              </div>
            </AccordionContent>
          </AccordionItem>
          )}
          {membership && (membership.role === 'owner' || membership.role === 'admin') && (
          <AccordionItem value="payment-methods" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-payment-methods">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cyan-500/10">
                  <CreditCard className="h-5 w-5 text-cyan-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Medios de Cobro</p>
                  <p className="text-sm text-muted-foreground font-normal">Definí comisiones, impuestos y costos asociados que se aplican automáticamente al cobrar</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="pt-2">
                <PaymentMethodsSection canEdit={!!membership && (membership.role === 'owner' || membership.role === 'admin')} />
              </div>
            </AccordionContent>
          </AccordionItem>
          )}
          {!isPersonalAccount && membership && (membership.role === 'owner' || membership.role === 'admin') && (
          <AccordionItem value="audit" className="border rounded-xl px-6 bg-card shadow-sm">
            <AccordionTrigger className="hover:no-underline py-5" data-testid="accordion-audit">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-orange-500/10">
                  <History className="h-5 w-5 text-orange-500" />
                </div>
                <div className="text-left">
                  <p className="font-semibold text-base">Auditoría</p>
                  <p className="text-sm text-muted-foreground font-normal">Historial de cambios realizados en el sistema</p>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-6">
              <div className="pt-2">
                <AuditLogsPage embedded />
              </div>
            </AccordionContent>
          </AccordionItem>
          )}
        </Accordion>
      </div>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Eliminar Organización
            </DialogTitle>
            <DialogDescription>
              ¿Estás seguro de que querés eliminar "{orgToDelete?.name}"? Esta acción eliminará todas las cuentas, movimientos y datos asociados. No se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} data-testid="button-cancel-delete">
              Cancelar
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleConfirmDelete}
              disabled={deleteOrgMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteOrgMutation.isPending ? 'Eliminando...' : 'Eliminar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingDeleteCategory} onOpenChange={(open) => { if (!open && !deletingCategory) setPendingDeleteCategory(null); }}>
        <DialogContent className="max-w-md" data-testid="dialog-delete-category">
          <DialogHeader>
            <DialogTitle>Eliminar categoría</DialogTitle>
            <DialogDescription>
              {pendingDeleteCategory && pendingDeleteCategory.count > 0 ? (
                <>
                  La categoría <span className="font-medium">"{pendingDeleteCategory.name}"</span> está siendo usada en{' '}
                  <span className="font-medium text-foreground" data-testid="text-category-usage-count">
                    {pendingDeleteCategory.count}
                  </span>{' '}
                  movimiento{pendingDeleteCategory.count !== 1 ? 's' : ''}. Si la eliminás sin reasignar,
                  esos movimientos van a quedar con una categoría que ya no existe y no vas a poder editarlos hasta cambiársela.
                </>
              ) : (
                <>¿Estás seguro de eliminar la categoría <span className="font-medium">"{pendingDeleteCategory?.name}"</span>? Esta acción no se puede deshacer.</>
              )}
            </DialogDescription>
          </DialogHeader>
          {pendingDeleteCategory && pendingDeleteCategory.count > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Reasignar movimientos a:</label>
              <Select
                value={pendingDeleteCategory.reassignTo || ''}
                onValueChange={(value) => setPendingDeleteCategory(prev => prev ? { ...prev, reassignTo: value } : prev)}
              >
                <SelectTrigger data-testid="select-reassign-category">
                  <SelectValue placeholder="Elegí una categoría de reemplazo" />
                </SelectTrigger>
                <SelectContent>
                  {categories
                    .filter(c => c.type === pendingDeleteCategory.type && c.name !== pendingDeleteCategory.name)
                    .map(c => (
                      <SelectItem key={c.id} value={c.name} data-testid={`option-reassign-${c.id}`}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Recomendado: elegí una categoría de reemplazo para mantener tus reportes consistentes.
              </p>
            </div>
          )}
          <DialogFooter className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setPendingDeleteCategory(null)}
              disabled={deletingCategory}
              data-testid="button-cancel-delete-category"
            >
              Cancelar
            </Button>
            {pendingDeleteCategory && pendingDeleteCategory.count > 0 && (
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => confirmDeleteCategory({ skipReassign: true })}
                disabled={deletingCategory}
                data-testid="button-delete-category-without-reassign"
                title="Los movimientos viejos van a quedar con una categoría que ya no existe."
              >
                Eliminar sin reasignar
              </Button>
            )}
            <Button
              variant="destructive"
              onClick={() => confirmDeleteCategory()}
              disabled={deletingCategory || (pendingDeleteCategory ? pendingDeleteCategory.count > 0 && !pendingDeleteCategory.reassignTo : false)}
              data-testid="button-confirm-delete-category"
            >
              {deletingCategory ? 'Eliminando...' : pendingDeleteCategory && pendingDeleteCategory.count > 0 ? 'Reasignar y eliminar' : 'Eliminar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingSubtypeChange} onOpenChange={(open) => { if (!open) setPendingSubtypeChange(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cambiar clasificación</DialogTitle>
            <DialogDescription>
              ¿Querés cambiar "{pendingSubtypeChange?.categoryName}" de{' '}
              <span className={pendingSubtypeChange?.currentSubtype === 'cost' ? 'text-orange-600 font-medium' : 'text-purple-600 font-medium'}>
                {pendingSubtypeChange?.currentSubtype === 'cost' ? 'Costo' : 'Gasto'}
              </span>{' '}a{' '}
              <span className={pendingSubtypeChange?.newSubtype === 'cost' ? 'text-orange-600 font-medium' : 'text-purple-600 font-medium'}>
                {pendingSubtypeChange?.newSubtype === 'cost' ? 'Costo' : 'Gasto'}
              </span>?
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            Elegí si el cambio aplica solo a transacciones nuevas o también a las existentes.
          </div>
          <DialogFooter className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setPendingSubtypeChange(null)}
              disabled={isApplyingSubtype}
              data-testid="btn-cancel-subtype-change"
              className="text-sm"
            >
              Cancelar
            </Button>
            <Button
              variant="secondary"
              disabled={isApplyingSubtype}
              data-testid="btn-subtype-only-new"
              className="text-sm"
              onClick={async () => {
                if (!pendingSubtypeChange) return;
                setIsApplyingSubtype(true);
                try {
                  await fetchWithAuth(`/organization/categories/${pendingSubtypeChange.categoryId}`, {
                    method: "PATCH",
                    body: JSON.stringify({ expenseSubtype: pendingSubtypeChange.newSubtype }),
                  });
                  queryClient.invalidateQueries({ queryKey: ["/organization/categories"] });
                  toast({ title: "Categoría actualizada", description: `"${pendingSubtypeChange.categoryName}" ahora es ${pendingSubtypeChange.newSubtype === 'cost' ? 'Costo' : 'Gasto'}. Solo aplica a transacciones nuevas.` });
                } catch (error: any) {
                  toast({ title: "Error", description: error.message, variant: "destructive" });
                } finally {
                  setIsApplyingSubtype(false);
                  setPendingSubtypeChange(null);
                }
              }}
            >
              Solo nuevas
            </Button>
            <Button
              disabled={isApplyingSubtype}
              data-testid="btn-subtype-all"
              className="text-sm"
              onClick={async () => {
                if (!pendingSubtypeChange) return;
                setIsApplyingSubtype(true);
                try {
                  const res = await fetchWithAuth(`/organization/categories/${pendingSubtypeChange.categoryId}`, {
                    method: "PATCH",
                    body: JSON.stringify({ expenseSubtype: pendingSubtypeChange.newSubtype, applyToExisting: true }),
                  });
                  queryClient.invalidateQueries({ queryKey: ["/organization/categories"] });
                  queryClient.invalidateQueries({ queryKey: ["/transactions"] });
                  const count = res?.updatedCount || 0;
                  toast({ title: "Categoría actualizada", description: `"${pendingSubtypeChange.categoryName}" ahora es ${pendingSubtypeChange.newSubtype === 'cost' ? 'Costo' : 'Gasto'}. ${count} transacción${count !== 1 ? 'es' : ''} actualizada${count !== 1 ? 's' : ''}.` });
                } catch (error: any) {
                  toast({ title: "Error", description: error.message, variant: "destructive" });
                } finally {
                  setIsApplyingSubtype(false);
                  setPendingSubtypeChange(null);
                }
              }}
            >
              {isApplyingSubtype ? 'Aplicando...' : 'Todas las transacciones'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Plan Change Confirmation Dialog */}
      <Dialog open={planChangeDialogOpen} onOpenChange={(open) => {
        if (!open && !isChangingPlan) {
          setPlanChangeDialogOpen(false);
          setPlanChangePreview(null);
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-primary" />
              Confirmar Cambio de Plan
            </DialogTitle>
          </DialogHeader>
          
          {planChangePreview && (
            <div className="space-y-4 py-4">
              <div className="flex justify-between items-center p-3 bg-muted/50 rounded-lg">
                <div>
                  <p className="text-sm text-muted-foreground">Plan actual</p>
                  <p className="font-medium">{planChangePreview.currentPlan}</p>
                </div>
                <ArrowRight className="h-5 w-5 text-muted-foreground" />
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">Nuevo plan</p>
                  <p className="font-medium">{planChangePreview.newPlan}</p>
                </div>
              </div>
              
              <div className="p-4 bg-primary/10 border border-primary/20 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <CreditCard className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-primary">Pago requerido</span>
                </div>
                <p className="text-2xl font-bold">
                  {(planChangePreview.newPrice / 100).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' })}/mes
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {planChangePreview.message}
                </p>
              </div>
            </div>
          )}
          
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setPlanChangeDialogOpen(false);
                setPlanChangePreview(null);
              }}
              disabled={isChangingPlan}
              data-testid="button-cancel-plan-change"
            >
              Cancelar
            </Button>
            <Button 
              onClick={handleConfirmPlanChange}
              disabled={isChangingPlan}
              data-testid="button-confirm-plan-change"
            >
              {isChangingPlan ? 'Redirigiendo...' : 'Ir a Pagar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelSubscriptionDialogOpen} onOpenChange={(open) => {
        setCancelSubscriptionDialogOpen(open);
        if (!open) setCancelConfirmationText('');
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Cancelar Suscripción
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-4">
              <p className="text-sm text-amber-800 dark:text-amber-200">
                Tu suscripción se cancelará al final del período de facturación actual. 
                Seguirás teniendo acceso hasta esa fecha.
              </p>
            </div>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p className="font-medium">¿Qué pasará después?</p>
              <ul className="space-y-1">
                <li>• Seguirás teniendo acceso hasta el final del período de facturación</li>
                <li>• Después, tu cuenta quedará inactiva pero tus datos se conservarán por 60 días</li>
                <li>• Recibirás recordatorios por email antes de la eliminación</li>
                <li>• Podés volver a suscribirte en cualquier momento y recuperar todo</li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelSubscriptionDialogOpen(false)} data-testid="button-cancel-cancel-subscription">
              Volver
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleCancelSubscription}
              disabled={isCancellingSubscription}
              data-testid="button-confirm-cancel-subscription"
            >
              {isCancellingSubscription ? 'Cancelando...' : 'Confirmar Cancelación'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteAccountDialogOpen} onOpenChange={(open) => {
        setDeleteAccountDialogOpen(open);
        if (!open) setDeleteAccountPassword('');
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Eliminar Cuenta Permanentemente
            </DialogTitle>
            <DialogDescription className="space-y-3">
              <p>Esta acción es <strong>irreversible</strong>. Se eliminarán permanentemente:</p>
              <ul className="list-disc list-inside text-sm space-y-1">
                <li>Tu cuenta de usuario</li>
                <li>Todas tus organizaciones</li>
                <li>Todos los movimientos y transacciones</li>
                <li>Cuentas, clientes, proveedores y productos</li>
                <li>Tu suscripción activa (si tenés una)</li>
              </ul>
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="delete-account-confirm">Escribí <strong>CANCELAR</strong> para confirmar</Label>
            <Input
              id="delete-account-confirm"
              type="text"
              value={deleteAccountPassword}
              onChange={(e) => setDeleteAccountPassword(e.target.value.toUpperCase())}
              placeholder="Escribí CANCELAR"
              className="mt-2"
              data-testid="input-delete-account-confirm"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteAccountDialogOpen(false)} data-testid="button-cancel-delete-account">
              Volver
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleDeleteAccount}
              disabled={isDeletingAccount || deleteAccountPassword !== 'CANCELAR'}
              data-testid="button-confirm-delete-account"
            >
              {isDeletingAccount ? 'Eliminando...' : 'Eliminar Cuenta'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog for creating account with different email */}
      <Dialog open={createAccountDialogOpen} onOpenChange={setCreateAccountDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-primary" />
              Importante: Usá un email diferente
            </DialogTitle>
            <DialogDescription className="space-y-3">
              <p>Tu email actual (<strong>{user?.email}</strong>) ya está asociado a este equipo.</p>
              <p>Para crear tu propia cuenta, tenés dos opciones:</p>
              <ul className="list-disc list-inside text-sm space-y-2 mt-2">
                <li><strong>Usar otro email:</strong> Registrate con un email diferente</li>
                <li><strong>Liberá tu email:</strong> Primero desafiliate de los equipos donde fuiste invitado, y después podrás usar este email para tu cuenta propia</li>
              </ul>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setCreateAccountDialogOpen(false)}>
              Cancelar
            </Button>
            <Button 
              onClick={() => {
                setCreateAccountDialogOpen(false);
                window.open('/register', '_blank');
              }}
            >
              Continuar con otro email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog for leaving a team */}
      <Dialog open={leaveTeamDialogOpen} onOpenChange={(open) => {
        setLeaveTeamDialogOpen(open);
        if (!open) setOrgToLeave(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-orange-500" />
              Abandonar equipo
            </DialogTitle>
            <DialogDescription className="space-y-3">
              <p>¿Estás seguro que querés abandonar <strong>{orgToLeave?.name}</strong>?</p>
              <p>Ya no tendrás acceso a esta organización ni a sus datos.</p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeaveTeamDialogOpen(false)} disabled={isLeavingTeam}>
              Cancelar
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleLeaveTeam}
              disabled={isLeavingTeam}
            >
              {isLeavingTeam ? 'Abandonando...' : 'Sí, abandonar equipo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Historial de pagos a Aikestar (Task #248) */}
      <Dialog open={paymentHistoryOpen} onOpenChange={(open) => { setPaymentHistoryOpen(open); if (!open) setPaymentHistoryMaximized(false); }}>
        <DialogContent
          className={
            paymentHistoryMaximized
              ? "w-screen h-screen max-w-none sm:max-w-none rounded-none overflow-hidden flex flex-col p-6"
              : "max-w-5xl w-[95vw] max-h-[85vh] overflow-hidden flex flex-col"
          }
        >
          <DialogHeader>
            <div className="flex items-start justify-between gap-4 pr-8">
              <div className="flex-1">
                <DialogTitle>Historial de pagos</DialogTitle>
                <DialogDescription>
                  Pagos realizados a Aikestar por tu suscripción. Podés descargar el comprobante de cada uno.
                </DialogDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPaymentHistoryMaximized((v) => !v)}
                data-testid="btn-toggle-payment-history-maximize"
              >
                {paymentHistoryMaximized ? 'Restaurar' : 'Maximizar'}
              </Button>
            </div>
          </DialogHeader>

          <div className="overflow-y-auto flex-1 -mx-6 px-6">
            {isLoadingPaymentHistory && (
              <div className="py-2 space-y-3" data-testid="payment-history-loading">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="p-4 rounded-lg border border-border bg-card">
                    <div className="flex items-center gap-3 mb-2">
                      <Skeleton className="h-5 w-24" />
                      <Skeleton className="h-4 w-16" />
                    </div>
                    <Skeleton className="h-3 w-48 mb-1.5" />
                    <Skeleton className="h-3 w-40" />
                  </div>
                ))}
              </div>
            )}

            {!isLoadingPaymentHistory && isPaymentHistoryError && (
              <div className="py-8 text-center space-y-3" data-testid="payment-history-error">
                <p className="text-sm text-muted-foreground">
                  No pudimos cargar el historial de pagos. Por favor intentá de nuevo.
                </p>
                <Button variant="outline" size="sm" onClick={() => refetchPaymentHistory()} data-testid="btn-retry-payment-history">
                  Reintentar
                </Button>
              </div>
            )}

            {!isLoadingPaymentHistory && !isPaymentHistoryError && paymentHistoryData && combinedPayments.length === 0 && (
              <div className="py-12 text-center" data-testid="payment-history-empty">
                <p className="text-sm text-muted-foreground">
                  Todavía no tenés pagos registrados en Aikestar.
                </p>
              </div>
            )}

            {!isLoadingPaymentHistory && !isPaymentHistoryError && paymentHistoryData && combinedPayments.length > 0 && (() => {
              const formatRow = (p: PaymentHistoryItem) => {
                const date = new Date(p.created * 1000);
                const dateLabel = date.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
                const amountLabel = new Intl.NumberFormat('es-AR', {
                  style: 'currency',
                  currency: p.currency || 'ARS',
                  maximumFractionDigits: 2,
                }).format((p.amount || 0) / 100);

                const statusLabel =
                  p.status === 'paid' ? 'Pagado' :
                  p.status === 'open' ? 'Pendiente' :
                  p.status === 'uncollectible' || p.status === 'void' ? 'Fallido' :
                  p.status === 'draft' ? 'Borrador' :
                  (p.status || '—');
                const statusClass =
                  p.status === 'paid'
                    ? 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30'
                    : p.status === 'open'
                    ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30'
                    : p.status === 'uncollectible' || p.status === 'void'
                    ? 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30'
                    : 'bg-muted text-muted-foreground border-border';

                const cardLabel = p.card?.brand && p.card?.last4
                  ? `${p.card.brand.charAt(0).toUpperCase() + p.card.brand.slice(1)} ····${p.card.last4}`
                  : '—';

                return { dateLabel, amountLabel, statusLabel, statusClass, cardLabel };
              };

              const renderDownloadLink = (p: PaymentHistoryItem) => {
                if (p.invoicePdf) {
                  return (
                    <a
                      href={p.invoicePdf}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3"
                      data-testid={`btn-download-invoice-${p.id}`}
                    >
                      Descargar PDF
                    </a>
                  );
                }
                if (p.hostedInvoiceUrl) {
                  return (
                    <a
                      href={p.hostedInvoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3"
                      data-testid={`btn-view-invoice-${p.id}`}
                    >
                      Ver comprobante
                    </a>
                  );
                }
                return <span className="text-xs text-muted-foreground">—</span>;
              };

              return (
                <>
                  {/* Desktop: tabla */}
                  <div className="hidden md:block" data-testid="payment-history-list">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Fecha</TableHead>
                          <TableHead>Plan</TableHead>
                          <TableHead className="text-right">Monto</TableHead>
                          <TableHead>Medio de pago</TableHead>
                          <TableHead>Estado</TableHead>
                          <TableHead className="text-right">Comprobante</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {combinedPayments.map((p) => {
                          const { dateLabel, amountLabel, statusLabel, statusClass, cardLabel } = formatRow(p);
                          return (
                            <TableRow key={p.id} data-testid={`payment-row-${p.id}`}>
                              <TableCell className="whitespace-nowrap text-sm" data-testid={`payment-date-${p.id}`}>{dateLabel}</TableCell>
                              <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate" title={p.description || ''}>
                                {p.description || '—'}
                              </TableCell>
                              <TableCell className="text-right font-medium whitespace-nowrap" data-testid={`payment-amount-${p.id}`}>{amountLabel}</TableCell>
                              <TableCell className="text-sm" data-testid={`payment-card-${p.id}`}>{cardLabel}</TableCell>
                              <TableCell>
                                <span className={`text-xs px-2 py-0.5 rounded border ${statusClass}`} data-testid={`payment-status-${p.id}`}>
                                  {statusLabel}
                                </span>
                              </TableCell>
                              <TableCell className="text-right">{renderDownloadLink(p)}</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Mobile: cards apiladas */}
                  <div className="md:hidden space-y-3 py-2">
                    {combinedPayments.map((p) => {
                      const { dateLabel, amountLabel, statusLabel, statusClass, cardLabel } = formatRow(p);
                      return (
                        <div
                          key={p.id}
                          className="p-4 rounded-lg border border-border bg-card flex flex-col gap-3"
                          data-testid={`payment-row-mobile-${p.id}`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-base">
                                {amountLabel}
                              </span>
                              <span className={`text-xs px-2 py-0.5 rounded border ${statusClass}`}>
                                {statusLabel}
                              </span>
                            </div>
                            <p className="text-sm text-muted-foreground mt-1">
                              {dateLabel}
                              {p.description ? <> · {p.description}</> : null}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Medio de pago: {cardLabel}
                              {p.number ? <> · N° {p.number}</> : null}
                            </p>
                          </div>
                          <div>{renderDownloadLink(p)}</div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Botón "Cargar más antiguos" para usuarios con muchos pagos */}
                  {canLoadMorePayments && (
                    <div className="pt-4 pb-2 flex flex-col items-center gap-2" data-testid="payment-history-load-more-container">
                      {olderPaymentsError && (
                        <p className="text-xs text-destructive" data-testid="payment-history-load-more-error">
                          No pudimos cargar más pagos. Intentá de nuevo.
                        </p>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleLoadMorePayments}
                        disabled={isLoadingOlderPayments}
                        data-testid="btn-load-more-payments"
                      >
                        {isLoadingOlderPayments ? 'Cargando…' : 'Cargar más antiguos'}
                      </Button>
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentHistoryOpen(false)} data-testid="btn-close-payment-history">
              Cerrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OrganizationBrandPicker
        key={brandPickerOrg?.id || 'brand-picker'}
        open={brandPickerOpen}
        onOpenChange={setBrandPickerOpen}
        currentLogoUrl={brandPickerOrg?.logoUrl}
        currentIconKey={brandPickerOrg?.iconKey}
        currentContactEmail={brandPickerOrg?.contactEmail}
        currentContactPhone={brandPickerOrg?.contactPhone}
        onSave={handleSaveBrand}
        orgId={brandPickerOrg?.id}
      />

      <Dialog open={showFirstLoginDialog} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="text-xl flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              ¡Bienvenido al equipo!
            </DialogTitle>
            <DialogDescription>
              Es tu primer ingreso. Por favor, configurá tu perfil y creá una nueva contraseña segura.
            </DialogDescription>
          </DialogHeader>
          
          <form onSubmit={firstLoginForm.handleSubmit(onFirstLoginSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label>Tu foto de perfil</Label>
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center border-2 border-primary/30">
                  {(() => {
                    const IconComponent = getProfileIconByKey(selectedProfileIcon);
                    return <IconComponent className="h-8 w-8 text-primary" />;
                  })()}
                </div>
                <UserProfilePicker
                  currentIconKey={selectedProfileIcon}
                  onIconChange={(iconKey) => setSelectedProfileIcon(iconKey || 'user')}
                  onImageChange={() => {}}
                  showUpload={false}
                />
              </div>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="first-login-name">Tu nombre</Label>
              <Input
                id="first-login-name"
                {...firstLoginForm.register('name')}
                placeholder="Tu nombre completo"
                data-testid="input-first-login-name"
              />
              {firstLoginForm.formState.errors.name && (
                <p className="text-xs text-destructive">{firstLoginForm.formState.errors.name.message}</p>
              )}
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="first-login-password">Nueva contraseña</Label>
              <div className="relative">
                <Input
                  id="first-login-password"
                  type={showFirstLoginPassword ? "text" : "password"}
                  {...firstLoginForm.register('newPassword')}
                  placeholder="Mínimo 6 caracteres"
                  data-testid="input-first-login-password"
                />
                <button
                  type="button"
                  onClick={() => setShowFirstLoginPassword(!showFirstLoginPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showFirstLoginPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {firstLoginForm.formState.errors.newPassword && (
                <p className="text-xs text-destructive">{firstLoginForm.formState.errors.newPassword.message}</p>
              )}
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="first-login-confirm">Confirmar contraseña</Label>
              <div className="relative">
                <Input
                  id="first-login-confirm"
                  type={showFirstLoginConfirm ? "text" : "password"}
                  {...firstLoginForm.register('confirmPassword')}
                  placeholder="Repetí tu nueva contraseña"
                  data-testid="input-first-login-confirm"
                />
                <button
                  type="button"
                  onClick={() => setShowFirstLoginConfirm(!showFirstLoginConfirm)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showFirstLoginConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {firstLoginForm.formState.errors.confirmPassword && (
                <p className="text-xs text-destructive">{firstLoginForm.formState.errors.confirmPassword.message}</p>
              )}
            </div>
            
            <Button 
              type="submit" 
              className="w-full"
              disabled={isFirstLoginSubmitting}
              data-testid="button-first-login-submit"
            >
              {isFirstLoginSubmitting ? 'Guardando...' : 'Configurar mi cuenta'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
