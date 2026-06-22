import type { Express, Request, Response } from "express";
import OpenAI from "../lib/claude";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
const execFileAsync = promisify(execFile);
const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);
const unlinkAsync = promisify(fs.unlink);
const readdirAsync = promisify(fs.readdir);
import rateLimit from 'express-rate-limit';
import { storage } from "../storage";
import { ASSET_TYPE_LABELS, ASSET_CATEGORY_LABELS, CURRENCIES } from "@shared/schema";
import { AI_MODELS, getArgentinaToday } from "@shared/constants";
import { requireAuth, sanitizeError } from "./middleware";
import { classifyTransaction, ClassificationInput } from "../services/transactionClassification";

// Cliente Claude con interfaz compatible OpenAI (ver server/lib/claude.ts).
const openai = new OpenAI();

interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Construye los `messages` para el modelo de visión a partir de un documento
// subido en base64 (imagen o PDF). Para PDFs intenta extraer texto con pdfjs y,
// si el PDF parece escaneado (poco texto), cae a convertir las primeras páginas
// a PNG con pdftocairo. Devuelve { messages } o { error } si no se pudo procesar.
async function buildDocMessages(
  systemPrompt: string,
  imageBase64: string,
  mimeType: string | undefined,
  userText: string,
): Promise<{ messages: any[] } | { error: string }> {
  const isPdf = mimeType === 'application/pdf';

  if (!isPdf) {
    return {
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`, detail: "high" } },
            { type: "text", text: userText },
          ],
        },
      ],
    };
  }

  const pdfBuffer = Buffer.from(imageBase64, 'base64');
  let pdfTextExtracted = '';
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await (pdfjsLib as any).getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, 5); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((item: any) => item.str).join(' '));
    }
    pdfTextExtracted = pages.join('\n').trim();
  } catch (parseErr: any) {
    console.error('PDF text extraction error:', parseErr.message);
  }

  if (pdfTextExtracted.length > 50) {
    return {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${userText}\n\nTEXTO DEL DOCUMENTO:\n${pdfTextExtracted.slice(0, 15000)}` },
      ],
    };
  }

  const tempWorkDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pdf_convert_'));
  try {
    const tempPdfPath = path.join(tempWorkDir, 'input.pdf');
    const tempOutputPrefix = path.join(tempWorkDir, 'page');
    await writeFileAsync(tempPdfPath, pdfBuffer);
    await execFileAsync('pdftocairo', ['-png', '-r', '200', '-l', '3', tempPdfPath, tempOutputPrefix], { timeout: 30000 });

    const dirFiles = await readdirAsync(tempWorkDir);
    const pageFiles = dirFiles.filter(f => f.startsWith('page') && f.endsWith('.png')).sort().slice(0, 3);

    if (pageFiles.length > 0) {
      const imageContents: any[] = [{ type: "text", text: userText }];
      for (const pageFile of pageFiles) {
        const pageBuffer = await readFileAsync(path.join(tempWorkDir, pageFile));
        imageContents.push({ type: "image_url", image_url: { url: `data:image/png;base64,${pageBuffer.toString('base64')}`, detail: "high" } });
      }
      return { messages: [{ role: "system", content: systemPrompt }, { role: "user", content: imageContents }] };
    }
  } catch (convError: any) {
    console.error('PDF image conversion fallback error:', convError.message);
  } finally {
    fs.promises.rm(tempWorkDir, { recursive: true, force: true }).catch(() => {});
  }

  return { error: 'Este PDF parece ser una imagen escaneada y no se pudo convertir. Probá subiendo una foto (JPG o PNG) del presupuesto.' };
}

function isTransactionRegistrationIntent(message: string): boolean {
  const msgLower = message.toLowerCase();
  
  const hasSpecificAmount = /\b\d+([.,]\d+)*\b/.test(msgLower) &&
    (/\b(gast[eé]|pagu[eé]|compr[eé]|cobr[eé]|recib[íi]|entr[oó]|ingres[oó]|vend[íi]|transfer[íi])\b/i.test(msgLower) ||
     /\b(registr[aáeé]|anot[aáeé]|carg[aáeé]|agreg[aáeé])\b/i.test(msgLower));
  
  if (hasSpecificAmount) return true;
  
  const registrationIntent = /\b(quiero\s+registrar|registr[aáeé]|anot[aáeé]|carg[aáeé]|agreg[aáeé])\s+(un[ao]?|el|la)?\s*(gasto|ingreso|pago|cobro|transacci[oó]n|movimiento)/i.test(msgLower);
  if (registrationIntent) return true;
  
  const quickRegistrationVerbs = /^(gast[eé]|pagu[eé]|compr[eé]|cobr[eé]|ingres[oó]|vend[íi])\b/i.test(msgLower);
  if (quickRegistrationVerbs) return true;

  return false;
}

const AIKESTAR_APP_MANUAL = `
=== MANUAL COMPLETO DE AIKESTAR ===

Aikestar es una plataforma de gestion financiera y administrativa para PyMEs y emprendedores argentinos.

--- DASHBOARD (Pantalla principal) ---
Tiene dos vistas:
- "Foto": muestra los saldos actuales de todas las cuentas del usuario, como una foto instantanea.
- "Pelicula": muestra el estado economico en el tiempo: ingresos vs gastos, desglose de costos vs gastos operativos, margen bruto y resultado neto.
- Barra de salud financiera: puntaje de 0 a 100 basado en liquidez, flujo de caja, rentabilidad, cumplimiento y respaldo patrimonial.
- Informes personalizados con IA: el usuario puede pedir reportes especificos desde el dashboard.

--- CUENTAS (Panel izquierdo) ---
- El usuario crea cuentas financieras (Efectivo, Banco, Mercado Pago, etc.) con moneda (ARS, USD, EUR).
- Cada cuenta tiene un saldo que se actualiza automaticamente con cada movimiento.
- Tipos: efectivo, banco, digital, inversion.
- Para crear una cuenta: hacer clic en "+ Agregar Cuenta" en el panel izquierdo.
- Las cuentas inactivas se limpian automaticamente despues de un periodo de gracia.

--- MOVIMIENTOS (Transacciones) ---
Tipos de movimientos:
- Ingreso: plata que entra (ej: cobro de servicio, venta).
- Gasto: plata que sale (ej: compra de insumos, pago de alquiler).
- Por cobrar (Receivable): alguien te debe plata (se genera un compromiso pendiente).
- Por pagar (Payable): vos debes plata (se genera un compromiso pendiente).
- Transferencia interna: mover plata entre cuentas propias sin afectar el balance total.

Como registrar un movimiento:
1. Desde la app: boton "+" en la seccion Movimientos > completar tipo, monto, cuenta, descripcion, categoria, factura.
2. Desde WhatsApp: escribirle a Aike por WhatsApp en lenguaje natural (ej: "gaste 5000 en alquiler").

Cada movimiento puede tener:
- Categoria (configurable en Ajustes)
- Factura/comprobante (A, B, C, E, M u Otro) con numero y CUIT
- Archivo adjunto (JPG, PNG, WebP, PDF)
- Recurrencia (mensual, semanal, etc.)
- Vinculacion a cliente o proveedor

Costos vs Gastos: los gastos se separan en "Costo" (produccion: proveedores, insumos, transporte) y "Gasto" (operativo/admin). Esto se configura por categoria en Ajustes.

Auto-aplicacion de pagos: cuando se registra un gasto con proveedor o un ingreso con cliente, el sistema automaticamente aplica el pago contra compromisos pendientes (por pagar/por cobrar) de esa entidad.

Cancelacion de movimientos: no se borran, se crea un movimiento inverso para mantener trazabilidad.

--- OFICINA (Payables/Receivables) ---
Muestra todos los compromisos pendientes:
- Por cobrar: lo que te deben clientes
- Por pagar: lo que debes a proveedores
- Boton "Pagar"/"Cobrar" para completar un compromiso
- Filtros por estado, fecha, cliente/proveedor

--- CLIENTES ---
- Lista de clientes con nombre, email, telefono, CUIT
- Cuenta Corriente (CC) por cliente: muestra el historial de debe/haber con saldo
- Se vinculan automaticamente a movimientos de ingreso y por cobrar

--- PROVEEDORES ---
- Lista de proveedores con nombre, email, telefono, CUIT
- Cuenta Corriente (CC) por proveedor: historial de debe/haber con saldo
- Se vinculan automaticamente a movimientos de gasto y por pagar

--- CUENTA CORRIENTE (CC) ---
Es el resumen de la relacion financiera con un cliente o proveedor:
- Muestra cada movimiento como "Debe" (lo que le debes o te deben) o "Haber" (pagos realizados)
- El saldo indica cuanto se debe actualmente
- Se alimenta automaticamente de los movimientos vinculados al cliente/proveedor

--- PRODUCTOS/SERVICIOS ---
- Inventario de productos con nombre, precio, stock
- Los movimientos pueden vincular productos, afectando el stock automaticamente

--- EMPLEADOS y RRHH ---
- Lista de empleados con datos personales y sueldo
- Liquidacion de sueldos y comisiones
- Vinculacion con proyectos para calcular comisiones

--- PROYECTOS ---
- Proyectos por cliente con presupuesto, estado, fechas
- Vinculacion de movimientos al proyecto
- Calculo de rentabilidad por proyecto
- Comisiones de empleados por proyecto

--- REPORTES ---
- Estado de Resultados (P&L): Ventas - Costos - Gastos = Resultado
- Balance de cuentas
- Reporte de valuacion del negocio (basado en EBITDA, activos, inversiones)
- Drill-down: hacer clic en cualquier numero del reporte para ver los movimientos detallados

--- ACTIVOS ---
- Registro de bienes de la empresa (vehiculos, equipos, muebles, etc.)
- Clasificacion por tipo y categoria
- Valor actual y depreciacion

--- INVERSIONES ---
- Registro de inversiones con rendimiento
- Seguimiento de performance

--- AJUSTES ---
- Categorias de movimientos (personalizables, con separacion Costo/Gasto)
- Preferencias del dashboard
- Preferencias del bot de WhatsApp (moneda por defecto, cuenta preferida)
- Gestion de equipo: invitar usuarios con roles (Operador, Especialista, Owner/Admin)
- Datos de la organizacion
- Suscripcion y facturacion (via Stripe)

--- NOTIFICACIONES ---
Sistema dual:
- Pendientes: compromisos por cobrar/pagar proximos a vencer
- Historial: notificaciones pasadas

--- WHATSAPP BOT ---
- Registra movimientos por lenguaje natural
- Aprende patrones del usuario (cuenta preferida, categorias frecuentes)
- Soporta voz (audio) y texto
- NO es lo mismo que este chat de ayuda

--- SUSCRIPCION ---
- Plan gratuito y planes pagos via Stripe
- Al cancelar, los datos se retienen 60 dias
- Emails recordatorio a los 15, 45 y 55 dias post-cancelacion
`;

async function generateConversationalResponse(
  userMessage: string,
  chatHistory: ChatHistoryMessage[],
  financialContext: string
): Promise<string> {
  const systemPrompt = `Sos Aike, el asistente de ayuda y guia dentro de Aikestar.

Tu rol es EXCLUSIVAMENTE ayudar, guiar y responder consultas. NO registras transacciones.

REGLAS:
- Responde siempre en espanol rioplatense (vos, tenes, etc.)
- Se conciso y claro. Usa maximo 2-3 parrafos.
- Si te piden registrar un gasto/ingreso/movimiento, indicales que usen el boton "+" en Movimientos o el bot de WhatsApp.
- Podes responder preguntas sobre: como usar la app, conceptos financieros, analisis de sus datos reales, consejos de gestion.
- Usa los datos financieros reales del usuario para responder consultas sobre sus finanzas.
- No inventes datos. Si no tenes informacion suficiente, decilo.
- No uses emojis excesivos. Maximo 1-2 por mensaje si es relevante.
- Cuando expliques como hacer algo en la app, da instrucciones paso a paso claras.

${AIKESTAR_APP_MANUAL}

DATOS REALES DEL USUARIO:
${financialContext}`;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];

  const recentHistory = chatHistory.slice(-10);
  for (const msg of recentHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: userMessage });

  const response = await openai.chat.completions.create({
    model: AI_MODELS.DEFAULT,
    messages,
    max_tokens: 800,
    temperature: 0.7,
  });

  return response.choices[0]?.message?.content || 'No pude generar una respuesta. Intenta de nuevo.';
}

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiadas consultas de IA. Esperá un momento antes de intentar de nuevo.' },
  // See note in server/routes/auth.ts authLimiter — Replit's proxy chain
  // requires app.set('trust proxy', true), which v8 of this lib flags as
  // permissive and uses to immediately 429 every request. Disabled here too.
  validate: { trustProxy: false, xForwardedForHeader: false },
});

export function registerAIRoutes(app: Express): void {
  app.use('/api/ai', aiLimiter);
  
  // Get chat history for a user within an organization (privacy isolation)
  app.get('/api/chat/history', requireAuth, async (req: any, res) => {
    try {
      const organizationId = req.organizationId;
      const userId = req.userId;
      const limit = parseInt(req.query.limit as string) || 100;
      
      // Get messages for this specific user in this organization
      const messages = await storage.getChatMessagesByOrganization(organizationId, limit, userId);
      
      res.json({
        messages: messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        })),
      });
    } catch (error: any) {
      console.error('Chat history error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error al obtener historial de chat' });
    }
  });

  // Clear chat history for an organization
  app.delete('/api/chat/history', requireAuth, async (req: any, res) => {
    try {
      const userId = req.userId;
      const organizationId = req.organizationId;
      
      await storage.clearChatHistory(organizationId, userId);
      
      res.json({ success: true, message: 'Historial de chat eliminado' });
    } catch (error: any) {
      console.error('Clear chat history error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error al limpiar historial de chat' });
    }
  });

  app.post('/api/ai/classify-transaction', requireAuth, async (req: any, res) => {
    try {
      const { description, amount, category, type, currency } = req.body;
      
      if (!description || !amount || !type) {
        return res.status(400).json({ message: 'Se requiere descripción, monto y tipo' });
      }
      
      const org = await storage.getOrganization(req.organizationId);
      
      const classificationInput: ClassificationInput = {
        description,
        amount: parseFloat(amount),
        category: category || 'General',
        type,
        currency: currency || org?.defaultCurrency || 'ARS',
        organizationCountry: org?.country || 'AR',
      };
      
      const result = await classifyTransaction(classificationInput);
      
      res.json({
        ...result,
        assetTypeLabel: ASSET_TYPE_LABELS[result.assetType],
        assetCategoryLabel: result.assetCategory ? ASSET_CATEGORY_LABELS[result.assetCategory] : null,
      });
    } catch (error: any) {
      console.error('AI Classification error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error en clasificación de IA' });
    }
  });

  app.post('/api/ai/analyze', requireAuth, async (req: any, res) => {
    try {
      const { text, accounts, conversationHistory, financialSummary, pendingTransactionContext } = req.body;
      
      if (!text || !text.trim()) {
        return res.status(400).json({ message: 'Se requiere texto para analizar' });
      }

      const textLower = text.toLowerCase();
      
      const distributionPatterns = {
        useAvailable: /\b(usar.*disponible|disponible.*primero|usar todo|lo que tengo|sacar.*primero)\b/i,
        allFromOne: /\b(todo de|cargar todo|descontar todo de|sacar todo de)\b/i,
        adjustAmount: /\b(ajustar|cambiar.*monto|bajar.*monto|reducir|otro monto)\b/i,
        distribute: /\b(distribuir|repartir|dividir|mixear|mezclar)\b/i,
      };
      
      const wantsDistribute = distributionPatterns.useAvailable.test(textLower) || distributionPatterns.distribute.test(textLower);
      const wantsAllFromOne = distributionPatterns.allFromOne.test(textLower);
      const wantsAdjustAmount = distributionPatterns.adjustAmount.test(textLower);
      const isDistributionResponse = wantsDistribute || wantsAllFromOne || wantsAdjustAmount;
      
      console.log('[AI Debug] Distribution detection:', { wantsDistribute, wantsAllFromOne, wantsAdjustAmount, isDistributionResponse });
      
      const confirmationPatterns = {
        affirmative: /^(s[ií]|si|dale|ok|bueno|listo|de una|perfecto|confirm[ao]|registr[ao]|hac[eé]lo|hazlo)$/i,
        wantsOverdraft: /\b(negativo|en rojo|igual|de todas formas|aunque no alcance|sin problema|no importa|registra)\b/i,
        selectsCash: /\b(cash|efectivo|caja)\b/i,
        selectsBank: /\b(banco|bank)\b/i,
      };
      
      const isConfirmation = confirmationPatterns.affirmative.test(textLower.trim());
      const wantsOverdraft = confirmationPatterns.wantsOverdraft.test(textLower);
      const selectsCashAccount = confirmationPatterns.selectsCash.test(textLower);
      const selectsBankAccount = confirmationPatterns.selectsBank.test(textLower);
      
      let selectedAccountName: string | null = null;
      if (accounts && accounts.length > 0) {
        for (const acc of accounts) {
          if (textLower.includes(acc.name.toLowerCase())) {
            selectedAccountName = acc.name;
            break;
          }
        }
      }
      
      console.log('[AI Debug] Confirmation detection:', { 
        isConfirmation, wantsOverdraft, selectsCashAccount, selectsBankAccount, selectedAccountName 
      });
      
      const incomeKeywords = /\b(recib[íi]|cobr[eé]|entr[oóa]|entraron|ingres[oóearon]+|me pagaron|vend[íi]|factur[eé] y cobr[eé])\b/i;
      const expenseKeywords = /\b(pagu[eé]|gast[eé]|compr[eé]|sali[oó]|salieron|transfer[íi])\b/i;
      const receivableKeywords = /\b(me deben|por cobrar|vend[íi] pero no cobr[eé]|factur[eé])\b/i;
      const payableKeywords = /\b(debo|tengo que pagar|por pagar)\b/i;
      
      let detectedType: string | null = null;
      if (receivableKeywords.test(textLower)) {
        detectedType = 'receivable';
      } else if (payableKeywords.test(textLower)) {
        detectedType = 'payable';
      } else if (incomeKeywords.test(textLower)) {
        detectedType = 'income';
      } else if (expenseKeywords.test(textLower)) {
        detectedType = 'expense';
      }
      
      let mentionsDollars = /\b(d[oó]lar|dolar|dolares|dolaes|usd|verdes|dollars|dol[aá]res)\b/i.test(textLower);
      const mentionsPesos = /\b(peso|pesos|ars)\b/i.test(textLower);
      let mentionsEuros = /\b(euro|euros|eur)\b/i.test(textLower);
      let detectedCurrency = mentionsDollars ? 'USD' : mentionsEuros ? 'EUR' : 'ARS';
      
      const amountMatch = textLower.match(/(\d+(?:[.,]\d+)?)/);
      let detectedAmount = amountMatch ? parseFloat(amountMatch[1].replace(',', '.')) : null;
      
      if (pendingTransactionContext) {
        console.log('[AI Debug] Merging with pending transaction context:', pendingTransactionContext);
        
        if (isDistributionResponse || isConfirmation || wantsOverdraft) {
          detectedType = pendingTransactionContext.type || detectedType;
          detectedAmount = pendingTransactionContext.amount || detectedAmount;
          detectedCurrency = pendingTransactionContext.currency || detectedCurrency;
          console.log('[AI Debug] Distribution/confirmation response - FORCING pending context:', { 
            type: detectedType, amount: detectedAmount, currency: detectedCurrency 
          });
        } else {
          if (!detectedType && pendingTransactionContext.type) {
            detectedType = pendingTransactionContext.type;
            console.log('[AI Debug] Using type from pending context:', detectedType);
          }
          
          if (!detectedAmount && pendingTransactionContext.amount) {
            detectedAmount = pendingTransactionContext.amount;
            console.log('[AI Debug] Using amount from pending context:', detectedAmount);
          }
          
          if (mentionsPesos) {
            detectedCurrency = 'ARS';
            console.log('[AI Debug] Overriding currency to ARS - user explicitly said pesos');
          } else if (mentionsDollars) {
            detectedCurrency = 'USD';
            console.log('[AI Debug] Overriding currency to USD based on current message');
          } else if (mentionsEuros) {
            detectedCurrency = 'EUR';
            console.log('[AI Debug] Overriding currency to EUR based on current message');
          } else if (pendingTransactionContext.currency) {
            detectedCurrency = pendingTransactionContext.currency;
            console.log('[AI Debug] Using currency from pending context:', detectedCurrency);
          }
        }
        
        mentionsDollars = detectedCurrency === 'USD' || detectedCurrency === 'USD_CASH';
        mentionsEuros = detectedCurrency === 'EUR';
      }
      
      console.log('[AI Pre-process] Detected:', { type: detectedType, currency: detectedCurrency, amount: detectedAmount });

      const allAccounts = accounts || [];
      const totalAccounts = allAccounts.length;
      
      console.log('[AI Debug] Accounts received:', allAccounts.map((a: any) => `${a.name} (${a.currency})`).join(', '));
      const hasOnlyOneAccount = totalAccounts === 1;
      const singleAccountName = hasOnlyOneAccount ? allAccounts[0]?.name : null;
      const singleAccountCurrency = hasOnlyOneAccount ? (allAccounts[0]?.currency || 'ARS') : null;
      
      const dollarAccounts = allAccounts.filter((a: any) => 
        a.currency === 'USD' || a.currency === 'USD_CASH'
      );
      const pesoAccounts = allAccounts.filter((a: any) => 
        !a.currency || a.currency === 'ARS'
      );
      const euroAccounts = allAccounts.filter((a: any) => 
        a.currency === 'EUR'
      );
      
      const accountsInfo = allAccounts.map((a: any) => {
        const curr = a.currency || 'ARS';
        const symbol = curr === 'USD' || curr === 'USD_CASH' ? 'U$D' : curr === 'EUR' ? '€' : '$';
        return `${a.name} (${curr}): ${symbol}${parseFloat(a.balance || 0).toLocaleString('es-AR')}`;
      }).join(' | ') || 'Sin cuentas';
      
      const dollarAccountsInfo = dollarAccounts.length > 0 
        ? dollarAccounts.map((a: any) => `${a.name}: U$D${parseFloat(a.balance || 0).toLocaleString('es-AR')}`).join(', ')
        : 'NINGUNA - NO tiene cuentas en dólares';
      
      const pesoAccountsInfo = pesoAccounts.length > 0
        ? pesoAccounts.map((a: any) => `${a.name}: $${parseFloat(a.balance || 0).toLocaleString('es-AR')}`).join(', ')
        : 'ninguna';
      
      const euroAccountsInfo = euroAccounts.length > 0
        ? euroAccounts.map((a: any) => `${a.name}: €${parseFloat(a.balance || 0).toLocaleString('es-AR')}`).join(', ')
        : 'ninguna';

      const totalBalance = allAccounts.reduce((sum: number, a: any) => sum + parseFloat(a.balance || 0), 0);
      const financialContext = financialSummary ? `
RESUMEN FINANCIERO ACTUAL:
- Saldo total disponible: $${totalBalance.toLocaleString('es-AR')}
- Por cobrar pendiente: $${(financialSummary.pendingReceivable || 0).toLocaleString('es-AR')}
- Por pagar pendiente: $${(financialSummary.pendingPayable || 0).toLocaleString('es-AR')}
- Posición neta: $${(financialSummary.netPosition || totalBalance).toLocaleString('es-AR')}` : '';

      const candidateAccounts = detectedCurrency === 'USD' ? dollarAccounts :
                                 detectedCurrency === 'EUR' ? euroAccounts : pesoAccounts;
      const needsAccountChoice = candidateAccounts.length > 1;
      const noCurrencyAccounts = candidateAccounts.length === 0 && (mentionsDollars || mentionsEuros);
      
      let recommendedAccount: any = null;
      let accountRecommendationReason = '';
      let insufficientFundsWarning = '';
      
      const totalAvailableInCurrency = candidateAccounts.reduce((sum: number, a: any) => 
        sum + parseFloat(a.balance || 0), 0
      );
      const maxSingleAccountBalance = candidateAccounts.length > 0 
        ? Math.max(...candidateAccounts.map((a: any) => parseFloat(a.balance || 0)))
        : 0;
      
      const isExpenseType = detectedType === 'expense' || detectedType === 'payable';
      const needsMoneyCheck = isExpenseType && detectedAmount && detectedAmount > 0;
      
      const userConfirmedOverdraft = wantsOverdraft || (pendingTransactionContext?.allowOverdraft === true);
      
      let distributionOptions = '';
      const amountForCalc = detectedAmount || 0;
      
      if (needsMoneyCheck && !userConfirmedOverdraft && amountForCalc > 0) {
        const currSymbol = detectedCurrency === 'USD' || detectedCurrency === 'USD_CASH' ? 'U$D' : detectedCurrency === 'EUR' ? '€' : '$';
        const totalShortfall = amountForCalc - totalAvailableInCurrency;
        
        if (totalAvailableInCurrency < amountForCalc && candidateAccounts.length > 1) {
          const sortedByBalance = [...candidateAccounts].sort((a: any, b: any) => 
            parseFloat(b.balance || 0) - parseFloat(a.balance || 0)
          );
          
          const highestAcc = sortedByBalance[0];
          const highestBal = parseFloat(highestAcc?.balance || 0);
          const option1Negative = amountForCalc - highestBal;
          
          let remaining = amountForCalc;
          const distribution: string[] = [];
          let lastAccountForNegative = '';
          for (const acc of sortedByBalance) {
            const bal = parseFloat(acc.balance || 0);
            if (bal > 0 && remaining > 0) {
              const useAmount = Math.min(bal, remaining);
              distribution.push(`${currSymbol} ${useAmount.toLocaleString('es-AR')} de ${acc.name}`);
              remaining -= useAmount;
            }
            lastAccountForNegative = acc.name;
          }
          if (remaining > 0 && lastAccountForNegative) {
            distribution.push(`${currSymbol} ${remaining.toLocaleString('es-AR')} de ${lastAccountForNegative} (quedaría en negativo)`);
          }
          
          distributionOptions = `
OPCIONES DE DISTRIBUCIÓN PARA OFRECER AL USUARIO:
1. TODO de ${highestAcc?.name}: quedaría con ${currSymbol} -${option1Negative.toLocaleString('es-AR')}
2. DISTRIBUIR: ${distribution.join(' + ')}
3. AJUSTAR el monto a lo que tiene disponible (${currSymbol} ${totalAvailableInCurrency.toLocaleString('es-AR')})

DEBÉS presentar estas opciones de forma amigable y preguntarle cuál prefiere.`;
          
          insufficientFundsWarning = `⚠️ FONDOS INSUFICIENTES: Quiere gastar ${currSymbol} ${amountForCalc.toLocaleString('es-AR')} pero solo tiene ${currSymbol} ${totalAvailableInCurrency.toLocaleString('es-AR')} en total. Faltan ${currSymbol} ${totalShortfall.toLocaleString('es-AR')}.${distributionOptions}`;
        } else if (totalAvailableInCurrency < amountForCalc) {
          insufficientFundsWarning = `⚠️ FONDOS INSUFICIENTES: Quiere gastar ${currSymbol} ${amountForCalc.toLocaleString('es-AR')} pero tiene ${currSymbol} ${totalAvailableInCurrency.toLocaleString('es-AR')}. Faltan ${currSymbol} ${totalShortfall.toLocaleString('es-AR')}. Preguntá si quiere registrar igual quedando en negativo, o ajustar el monto.`;
        } else if (maxSingleAccountBalance < amountForCalc) {
          insufficientFundsWarning = `⚠️ SALDO AJUSTADO: Ninguna cuenta individual tiene ${currSymbol} ${amountForCalc.toLocaleString('es-AR')} disponibles. La cuenta con más saldo tiene ${currSymbol} ${maxSingleAccountBalance.toLocaleString('es-AR')}. Podría quedar en negativo. DEBÉS preguntar si lo registra igual o prefiere otra opción.`;
        }
      }
      
      console.log('[AI Debug] Overdraft check:', { userConfirmedOverdraft, wantsOverdraft, insufficientFundsWarning: !!insufficientFundsWarning });
      
      if (candidateAccounts.length >= 1) {
        const sortedByBalance = [...candidateAccounts].sort((a: any, b: any) => 
          parseFloat(a.balance || 0) - parseFloat(b.balance || 0)
        );
        
        if (detectedType === 'income' || detectedType === 'receivable') {
          const negativeAccounts = sortedByBalance.filter((a: any) => parseFloat(a.balance || 0) < 0);
          if (negativeAccounts.length > 0) {
            recommendedAccount = negativeAccounts[0];
            accountRecommendationReason = `tiene saldo negativo (${recommendedAccount.currency === 'USD' || recommendedAccount.currency === 'USD_CASH' ? 'U$D ' : 'AR$ '}${parseFloat(recommendedAccount.balance).toLocaleString('es-AR')}) - conviene cubrir el descubierto`;
          }
        } else if (isExpenseType) {
          const positiveAccounts = sortedByBalance.filter((a: any) => parseFloat(a.balance || 0) > 0).reverse();
          if (positiveAccounts.length > 0) {
            recommendedAccount = positiveAccounts[0];
            accountRecommendationReason = `tiene más saldo disponible`;
          }
        }
      }
      
      let userSelectedAccount: any = null;
      if (selectedAccountName) {
        userSelectedAccount = candidateAccounts.find((a: any) => 
          a.name.toLowerCase() === selectedAccountName.toLowerCase()
        ) || allAccounts.find((a: any) => 
          a.name.toLowerCase() === selectedAccountName.toLowerCase()
        );
      } else if (selectsCashAccount) {
        userSelectedAccount = candidateAccounts.find((a: any) => 
          a.name.toLowerCase().includes('cash') || 
          a.name.toLowerCase().includes('efectivo') ||
          a.name.toLowerCase().includes('caja')
        );
      } else if (selectsBankAccount) {
        userSelectedAccount = candidateAccounts.find((a: any) => 
          a.name.toLowerCase().includes('banco') || 
          a.name.toLowerCase().includes('bank')
        );
      }
      
      console.log('[AI Debug] Account selection:', { selectedAccountName, selectsCashAccount, selectsBankAccount, userSelectedAccount: userSelectedAccount?.name });

      const userConfirmationHint = userConfirmedOverdraft 
        ? `\n✅ EL USUARIO CONFIRMÓ QUE QUIERE REGISTRAR EN NEGATIVO. Procedé a registrar la transacción sin volver a preguntar.\n`
        : '';
      
      const accountSelectedHint = userSelectedAccount
        ? `\n✅ EL USUARIO ELIGIÓ LA CUENTA: "${userSelectedAccount.name}". Usá esta cuenta y confirmá el registro.\n`
        : '';
      
      let distributionChoiceHint = '';
      if (isDistributionResponse && pendingTransactionContext) {
        const currSymbol = detectedCurrency === 'USD' || detectedCurrency === 'USD_CASH' ? 'U$D' : detectedCurrency === 'EUR' ? '€' : '$';
        if (wantsDistribute) {
          distributionChoiceHint = `\n✅ EL USUARIO ELIGIÓ DISTRIBUIR (usar lo disponible primero). Confirmá que vas a usar todo el saldo disponible de las cuentas en ${detectedCurrency} y el resto quedará en negativo en una cuenta. Preguntá en cuál cuenta quiere que quede el negativo.\n`;
        } else if (wantsAdjustAmount) {
          distributionChoiceHint = `\n✅ EL USUARIO QUIERE AJUSTAR EL MONTO. Preguntá cuál es el nuevo monto que quiere registrar (máximo disponible: ${currSymbol} ${totalAvailableInCurrency.toLocaleString('es-AR')}).\n`;
        } else if (wantsAllFromOne) {
          distributionChoiceHint = `\n✅ EL USUARIO QUIERE TODO DE UNA CUENTA. Preguntá de cuál cuenta específica quiere descontar todo (quedará en negativo).\n`;
        }
      }
      
      const serverHints = `
🔒 DETECCIÓN AUTOMÁTICA DEL SERVIDOR (OBLIGATORIO RESPETAR):
${userConfirmationHint}${accountSelectedHint}${distributionChoiceHint}${detectedType ? `✓ TIPO DETECTADO: ${detectedType.toUpperCase()} (el usuario dijo "${text}" → esto es ${detectedType === 'income' ? 'dinero que ENTRA' : detectedType === 'expense' ? 'dinero que SALE' : detectedType})` : ''}
${detectedAmount ? `✓ MONTO DETECTADO: ${detectedAmount}` : ''}
${detectedCurrency ? `✓ MONEDA DETECTADA: ${detectedCurrency}` : ''}
${insufficientFundsWarning ? `\n${insufficientFundsWarning}\n` : ''}
${needsAccountChoice && !userSelectedAccount ? `⚠️ HAY ${candidateAccounts.length} CUENTAS EN ${detectedCurrency}: ${candidateAccounts.map((a:any) => `${a.name} (saldo: ${a.currency === 'USD' || a.currency === 'USD_CASH' ? 'U$D ' : 'AR$ '}${parseFloat(a.balance || 0).toLocaleString('es-AR')})`).join(', ')} → DEBÉS PREGUNTAR EN CUÁL CUENTA` : ''}
${recommendedAccount && !userSelectedAccount ? `🔴 OBLIGATORIO: Cuando preguntes la cuenta, DEBÉS recomendar "${recommendedAccount.name}" diciendo que ${accountRecommendationReason}. Ejemplo: "Te recomiendo ${recommendedAccount.name} porque ${accountRecommendationReason}. ¿Lo cargo ahí o preferís otra cuenta?"` : ''}
${noCurrencyAccounts ? `⚠️ NO HAY CUENTAS EN ${detectedCurrency} → Avisale al usuario` : ''}
${candidateAccounts.length === 1 ? `✓ ÚNICA CUENTA EN ${detectedCurrency}: ${candidateAccounts[0]?.name} → Usá esta automáticamente` : ''}
`;

      const argToday = getArgentinaToday();
      const [argYear, argMonth] = argToday.split('-').map(Number);
      const systemPrompt = `Sos Aike 🧉, el mejor asesor financiero de Argentina. Sos experto en finanzas de pymes, súper inteligente, cálido, comprensivo y respetuoso.
${serverHints}

🧠 TU EXPERTISE FINANCIERO:
Sos un experto que ANALIZA antes de actuar. Cuando hay múltiples cuentas disponibles:
1. SIEMPRE recomendá estratégicamente basándote en los saldos
2. Para INGRESOS: priorizá cuentas con saldo negativo (para cubrir descubiertos)
3. Para EGRESOS: priorizá cuentas con mayor saldo disponible
4. Explicá TU RAZONAMIENTO de forma breve: "Te recomiendo X porque está en rojo" o "mejor desde Y que tiene más plata"

⛔ REGLA #1 OBLIGATORIA - MONEDAS:
Las cuentas tienen monedas FIJAS. ESTÁ PROHIBIDO mezclar monedas.

CUENTAS EN DÓLARES (USD/USD_CASH): ${dollarAccountsInfo}
CUENTAS EN PESOS (ARS): ${pesoAccountsInfo}
CUENTAS EN EUROS (EUR): ${euroAccountsInfo}

ALGORITMO OBLIGATORIO:
1. Si el usuario dice "dólares/dolares/usd/verdes/dollars" → SOLO podés usar cuentas USD/USD_CASH
2. Si NO hay cuentas en USD, decí: "No tenés ninguna cuenta en dólares. ¿Querés que te ayude a crear una?"
3. NUNCA registres dólares en cuenta de pesos

⛔ REGLA #2 - TIPO DE TRANSACCIÓN:
INGRESOS (income): "vendí", "cobré", "recibí", "me pagaron", "entraron", "ingresó"
EGRESOS (expense): "pagué", "gasté", "compré", "salió", "transferí"
POR COBRAR (receivable): "me deben", "facturé" (sin cobrar)
POR PAGAR (payable): "debo", "tengo que pagar"

🎭 TU PERSONALIDAD ARGENTINA:
- Sos cálido y comprensivo, como un amigo que sabe de finanzas
- Usás voseo natural: "che", "dale", "joya", "de una", "tranqui"
- Sos empático: si alguien tiene cuentas en rojo, no juzgás, ayudás
- Usás emojis con moderación (💰 💳 ✅ 📊)
- Festejás los logros genuinamente

📊 CONOCIMIENTO DE LA ORGANIZACIÓN:
${hasOnlyOneAccount ? `⭐ SOLO TIENE UNA CUENTA: "${singleAccountName}" (${singleAccountCurrency})` : `Total de cuentas: ${totalAccounts}`}
Todas las cuentas CON SALDOS: ${accountsInfo}
${financialContext}

🧠 REGLAS DE RECOMENDACIÓN:
- CUENTA ÚNICA en esa moneda: Usala automáticamente sin preguntar
- MÚLTIPLES CUENTAS: Preguntá PERO recomendá una basándote en los saldos
- Ejemplo bueno: "Tenés Banco Piano (U$D -1.000) y Caja Dolares (U$D 721). Te recomiendo Banco Piano para cubrir ese descubierto. ¿Lo cargo ahí?"

TIPOS: income, expense, receivable, payable
CATEGORÍAS: Ventas, Combustible, Servicios, Suscripciones, Viáticos, Sueldos, Impuestos, Proveedores, Alquiler, Mantenimiento, Insumos, Otros

📅 FECHAS FUTURAS:
- Si el usuario menciona una fecha futura ("en febrero", "el 15", "la semana que viene"), incluí el campo "dueDate" en formato YYYY-MM-DD
- Para payables/receivables con fecha futura, SIEMPRE usá isTransaction:true
- Meses: enero=01, febrero=02, marzo=03, abril=04, mayo=05, junio=06, julio=07, agosto=08, septiembre=09, octubre=10, noviembre=11, diciembre=12
- ⚠️ IMPORTANTE: Si mencionan un mes SIN año, usá el PRÓXIMO mes con ese nombre (nunca en el pasado)
  - Hoy es: ${argToday} (año ${argYear}, mes ${argMonth})
  - Si dicen "enero" y estamos en diciembre 2025, usá 2026-01-XX
  - Si dicen "febrero" y estamos en enero 2026, usá 2026-02-XX
  - REGLA: Si el mes mencionado es <= al mes actual, sumale 1 al año

📋 FORMATO JSON:
{"message":"texto","status":"needs_info|ready","isTransaction":true|false,"type":"income","amount":0,"description":"","category":"Otros","accountSuggestion":"nombre o null","confidence":90,"dueDate":"YYYY-MM-DD o null"}

💬 EJEMPLOS CRÍTICOS:

Usuario: "vendí 50000 dólares en servicios"
→ Cuentas USD: NINGUNA
{"message":"Ojo! 💵 No tenés ninguna cuenta en dólares. ¿Querés crear una, o lo convierto a pesos?","status":"needs_info","isTransaction":false}

Usuario: "vendí 50000 dólares" (y tiene UNA cuenta USD: "Caja USD")
{"message":"¡Genial! 💵 U$D 50.000 de venta, entra a Caja USD. ¿Confirmo?","status":"ready","isTransaction":true,"type":"income","amount":50000,"description":"Venta","category":"Ventas","accountSuggestion":"Caja USD","confidence":95}

Usuario: "cobré 1000 dólares" (y tiene DOS cuentas USD: "Banco Piano" y "Caja Dolares")
{"message":"¡Joya! 💵 U$D 1.000 para registrar. Tenés Banco Piano y Caja Dolares en dólares. ¿En cuál lo cargo?","status":"needs_info","isTransaction":true,"type":"income","amount":1000,"description":"Cobro","category":"Ventas","accountSuggestion":null,"confidence":70}

Usuario: "vendí 100000 pesos en marketing y ya lo cobré"
{"message":"¡Excelente venta! 💰 $100.000 de marketing, entra a tu cuenta. ¿Lo registro?","status":"ready","isTransaction":true,"type":"income","amount":100000,"description":"Venta marketing","category":"Ventas","accountSuggestion":"${pesoAccounts.length > 0 ? pesoAccounts[0]?.name : ''}","confidence":95,"dueDate":null}

Usuario: "tengo que pagar 10000 dólares de alquiler en enero"
(Si hoy es diciembre 2025, enero es 2026)
{"message":"📅 ¡Anotado! Alquiler de U$D 10.000 para enero. Te lo registro como pago pendiente en Banco Piano. ¿Confirmo?","status":"ready","isTransaction":true,"type":"payable","amount":10000,"description":"Alquiler","category":"Alquiler","accountSuggestion":"Banco Piano","confidence":95,"dueDate":"2026-01-08"}

Usuario: "me van a pagar 50000 la semana que viene"
(Calculá 7 días desde hoy)
{"message":"💰 Cobro de $50.000 para la semana que viene. Lo anoto como por cobrar. ¿Dale?","status":"ready","isTransaction":true,"type":"receivable","amount":50000,"description":"Cobro pendiente","category":"Ventas","accountSuggestion":"${pesoAccounts.length > 0 ? pesoAccounts[0]?.name : ''}","confidence":90,"dueDate":"${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 7*24*60*60*1000))}"}

⚠️ El "message" es SOLO texto natural. NUNCA JSON en el mensaje.`;

      const messages: Array<{ role: 'system' | 'user' | 'assistant', content: string }> = [
        { role: "system", content: systemPrompt }
      ];
      
      if (conversationHistory && Array.isArray(conversationHistory)) {
        for (const msg of conversationHistory) {
          messages.push({ 
            role: msg.role as 'user' | 'assistant', 
            content: msg.content 
          });
        }
      }
      
      messages.push({ role: "user", content: text });

      const response = await openai.chat.completions.create({
        model: AI_MODELS.ADVANCED,
        messages,
        max_tokens: 300,
        temperature: 0.7,
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content || '{}';
      console.log('[AI Debug] Raw AI response:', content);
      
      let analysis;
      try {
        let cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          cleanContent = jsonMatch[0];
        }
        
        analysis = JSON.parse(cleanContent);
        
        if (analysis.message && typeof analysis.message === 'string') {
          analysis.message = analysis.message
            .replace(/\{[^}]*"message"[^}]*\}/g, '')
            .replace(/\{"[^"]*":[^}]*\}/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        }
        
        console.log('[AI Debug] Pre-correction analysis:', { 
          aiType: analysis.type, 
          detectedType, 
          needsAccountChoice,
          candidateAccountsCount: candidateAccounts.length 
        });
        
        if (detectedType && analysis.type && analysis.type !== detectedType) {
          console.log(`[AI Fix] Correcting type: ${analysis.type} → ${detectedType}`);
          analysis.type = detectedType;
          const typeLabels: Record<string, string> = {
            income: 'ingreso',
            expense: 'egreso', 
            receivable: 'por cobrar',
            payable: 'por pagar'
          };
          if (analysis.message) {
            analysis.message = analysis.message
              .replace(/egreso/gi, typeLabels[detectedType] || detectedType)
              .replace(/sale de/gi, detectedType === 'income' ? 'entra a' : 'sale de');
          }
        }
        
        if (userConfirmedOverdraft && userSelectedAccount) {
          console.log(`[AI Fix] User confirmed overdraft AND selected account: ${userSelectedAccount.name} - proceeding to register`);
          analysis.status = 'ready';
          analysis.accountSuggestion = userSelectedAccount.name;
        } else if (userConfirmedOverdraft && candidateAccounts.length === 1) {
          console.log(`[AI Fix] User confirmed overdraft with single account: ${candidateAccounts[0].name}`);
          analysis.status = 'ready';
          analysis.accountSuggestion = candidateAccounts[0].name;
        } else if (userSelectedAccount && !insufficientFundsWarning) {
          console.log(`[AI Fix] User selected account: ${userSelectedAccount.name} - using it`);
          analysis.status = 'ready';
          analysis.accountSuggestion = userSelectedAccount.name;
        }
        
        const skipTemplates = userConfirmedOverdraft || userSelectedAccount || isDistributionResponse;
        
        const aiMentionsInsufficientFunds = /no te.*alcanza|no ten[eé]s suficiente|faltar[ií]an|insuficiente|no hay.*suficiente|quedar[ií]as? en negativo/i.test(analysis.message || '');
        
        if (!skipTemplates && needsAccountChoice && analysis.accountSuggestion && !aiMentionsInsufficientFunds) {
          console.log(`[AI Fix] Multiple accounts available, forcing choice with recommendation`);
          const symbol = detectedCurrency === 'USD' ? 'U$D ' : detectedCurrency === 'EUR' ? '€' : 'AR$ ';
          analysis.status = 'needs_info';
          analysis.confidence = 70;
          
          const totalInCurrency = candidateAccounts.reduce((sum: number, a: any) => sum + parseFloat(a.balance || 0), 0);
          const isExpense = detectedType === 'expense' || detectedType === 'payable';
          const amount = detectedAmount || 0;
          const notEnoughFunds = isExpense && amount > 0 && totalInCurrency < amount;
          
          const accountListWithBalances = candidateAccounts.map((a: any) => 
            `${a.name} (${symbol} ${parseFloat(a.balance || 0).toLocaleString('es-AR')})`
          ).join(' y ');
          
          if (notEnoughFunds) {
            const shortfall = amount - totalInCurrency;
            analysis.accountSuggestion = null;
            analysis.message = `Ojo 👀 Querés gastar ${symbol} ${amount.toLocaleString('es-AR')} pero en total tenés ${symbol} ${totalInCurrency.toLocaleString('es-AR')} entre ${accountListWithBalances}. Te faltarían ${symbol} ${shortfall.toLocaleString('es-AR')}. ¿Lo registro igual (quedarías en negativo) o preferís ajustar el monto?`;
            console.log(`[AI Fix] Insufficient funds warning - shortfall: ${symbol} ${shortfall}`);
          } else if (recommendedAccount) {
            analysis.accountSuggestion = recommendedAccount.name;
            analysis.message = `¡${detectedType === 'income' ? 'Genial' : 'Dale'}! ${symbol} ${detectedAmount?.toLocaleString('es-AR') || analysis.amount?.toLocaleString('es-AR')} de ${analysis.description || 'operación'}. Tenés ${accountListWithBalances}. Te recomiendo ${recommendedAccount.name} porque ${accountRecommendationReason}. ¿Lo ${detectedType === 'income' ? 'cargo' : 'descuento'} ahí?`;
          } else {
            analysis.accountSuggestion = null;
            analysis.message = `¡${detectedType === 'income' ? 'Genial' : 'Dale'}! ${symbol} ${detectedAmount?.toLocaleString('es-AR') || analysis.amount?.toLocaleString('es-AR')} de ${analysis.description || 'operación'}. Tenés ${accountListWithBalances}. ¿En cuál lo ${detectedType === 'income' ? 'cargo' : 'descuento'}?`;
          }
        } else if (aiMentionsInsufficientFunds) {
          console.log(`[AI Fix] AI already mentioned insufficient funds - keeping original message`);
          analysis.status = 'needs_info';
        }
        
        analysis.currency = detectedCurrency;
        
        const aiSaysNoDollarAccount = /no ten[eé]s.*cuenta.*d[oó]lar|ninguna cuenta.*d[oó]lar/i.test(analysis.message || '');
        if (!skipTemplates && mentionsDollars && aiSaysNoDollarAccount && dollarAccounts.length > 0) {
          console.log(`[AI Fix] Correcting false "no dollar accounts" - accounts exist:`, dollarAccounts.map((a:any) => a.name));
          
          const totalUsdAvailable = dollarAccounts.reduce((sum: number, a: any) => sum + parseFloat(a.balance || 0), 0);
          const isUsdExpense = detectedType === 'expense' || detectedType === 'payable';
          const usdAmount = detectedAmount || 0;
          const notEnoughUsd = isUsdExpense && usdAmount > 0 && totalUsdAvailable < usdAmount;
          const shortfall = usdAmount - totalUsdAvailable;
          
          const usdAccountsWithBalances = dollarAccounts.map((a: any) => 
            `${a.name} (U$D ${parseFloat(a.balance || 0).toLocaleString('es-AR')})`
          ).join(' y ');
          
          if (notEnoughUsd) {
            analysis.status = 'needs_info';
            analysis.accountSuggestion = null;
            analysis.message = `Ojo 👀 Querés gastar U$D ${usdAmount.toLocaleString('es-AR')} pero en total tenés U$D ${totalUsdAvailable.toLocaleString('es-AR')} entre ${usdAccountsWithBalances}. Te faltarían U$D ${shortfall.toLocaleString('es-AR')}. ¿Lo registro igual (quedarías en negativo) o preferís ajustar el monto?`;
          } else if (dollarAccounts.length === 1) {
            const acc = dollarAccounts[0];
            analysis.accountSuggestion = acc.name;
            analysis.status = 'ready';
            analysis.message = `¡${detectedType === 'income' ? 'Genial' : 'Dale'}! 💵 U$D ${detectedAmount?.toLocaleString('es-AR') || ''} de ${analysis.description || 'operación'}. ${detectedType === 'income' ? 'Entra a' : 'Sale de'} ${acc.name}. ¿Confirmo?`;
          } else {
            analysis.status = 'needs_info';
            analysis.accountSuggestion = null;
            analysis.message = `¡${detectedType === 'income' ? 'Genial' : 'Dale'}! 💵 U$D ${detectedAmount?.toLocaleString('es-AR') || ''} de ${analysis.description || 'operación'}. Tenés ${usdAccountsWithBalances}. ¿En cuál lo ${detectedType === 'income' ? 'cargo' : 'descuento'}?`;
          }
          analysis.type = detectedType || 'expense';
          analysis.isTransaction = true;
        }
        
        if (detectedAmount && !analysis.amount) {
          analysis.amount = detectedAmount;
        }
        
        if (analysis.dueDate) {
          analysis.date = analysis.dueDate;
        }
      } catch (parseError) {
        console.log('[AI Debug] Parse error, falling back:', parseError);
        return res.json({ 
          message: content.replace(/\{[\s\S]*\}/g, '').trim() || 'No entendí, ¿podés decirlo de otra forma?',
          isTransaction: false
        });
      }

      console.log('[AI Debug] Final response:', JSON.stringify(analysis));
      res.json(analysis);
    } catch (error: any) {
      console.error('AI Analysis error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error en analisis de IA' });
    }
  });

  app.post('/api/ai/chat', requireAuth, async (req: any, res) => {
    try {
      const { message, reset } = req.body;
      const userId = req.userId;
      const organizationId = req.organizationId;
      
      if (reset) {
        const welcomeMessage = 'Hola! Soy Aike, tu asistente de ayuda y guia en Aikestar. Preguntame lo que necesites: como usar la app, conceptos financieros, o consulta tus datos reales. Estoy para ayudarte!';
        
        await storage.createChatMessage({
          organizationId,
          userId,
          role: 'assistant',
          content: welcomeMessage,
        });
        
        return res.json({ message: welcomeMessage });
      }
      
      if (!message || !message.trim()) {
        return res.status(400).json({ message: 'Se requiere un mensaje' });
      }
      
      const userMessage = message.trim();
      const [accounts, clients, suppliers, employees] = await Promise.all([
        storage.getAccountsByOrganization(organizationId),
        storage.getClientsByOrganization(organizationId, true),
        storage.getSuppliersByOrganization(organizationId, true),
        storage.getEmployeesByOrganization(organizationId, true),
      ]);
      
      await storage.createChatMessage({
        organizationId,
        userId,
        role: 'user',
        content: userMessage,
      });

      if (isTransactionRegistrationIntent(userMessage)) {
        const redirectMsg = 'Para registrar movimientos tenes dos opciones:\n\n' +
          '1. **WhatsApp**: Escribile a Aike por WhatsApp y decile lo que quieras registrar de forma natural\n' +
          '2. **Boton "+"**: Usa el boton "+" en la seccion de Movimientos para cargar manualmente\n\n' +
          'Yo estoy aca para ayudarte con dudas, guiarte en la app y analizar tus datos financieros.';
        
        await storage.createChatMessage({ organizationId, userId, role: 'assistant', content: redirectMsg });
        
        return res.json({ message: redirectMsg });
      }
      
      const chatHistory = await storage.getChatMessagesByOrganization(organizationId, 50, userId);
      const historyMessages: ChatHistoryMessage[] = chatHistory.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
      
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      const allTransactions = await storage.getTransactionsByOrganization(organizationId);
      const recentTransactions = allTransactions
        .filter(t => new Date(t.date) >= threeMonthsAgo)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();

      const thisMonthTransactions = recentTransactions.filter(t => {
        const d = new Date(t.date);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
      });

      const lastMonthDate = new Date(currentYear, currentMonth - 1, 1);
      const lastMonthTransactions = recentTransactions.filter(t => {
        const d = new Date(t.date);
        return d.getMonth() === lastMonthDate.getMonth() && d.getFullYear() === lastMonthDate.getFullYear();
      });

      const thisMonthExpenses = thisMonthTransactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + parseFloat(t.amount), 0);
      const thisMonthIncome = thisMonthTransactions.filter(t => t.type === 'income').reduce((sum, t) => sum + parseFloat(t.amount), 0);
      const lastMonthExpenses = lastMonthTransactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + parseFloat(t.amount), 0);
      const lastMonthIncome = lastMonthTransactions.filter(t => t.type === 'income').reduce((sum, t) => sum + parseFloat(t.amount), 0);

      const expensesByCategory: Record<string, number> = {};
      thisMonthTransactions.filter(t => t.type === 'expense').forEach(t => {
        const cat = t.category || 'Sin categoria';
        expensesByCategory[cat] = (expensesByCategory[cat] || 0) + parseFloat(t.amount);
      });
      const topCategories = Object.entries(expensesByCategory)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat, amount]) => `${cat}: $${amount.toLocaleString('es-AR')}`);

      const totalBalance = accounts.reduce((sum: number, a: { balance: string | null }) => sum + parseFloat(a.balance || '0'), 0);
      const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

      const pendingReceivables = recentTransactions.filter(t => t.type === 'receivable' && t.status !== 'completed');
      const pendingPayables = recentTransactions.filter(t => t.type === 'payable' && t.status !== 'completed');
      const pendingReceivableTotal = pendingReceivables.reduce((sum, t) => sum + parseFloat(t.amount), 0);
      const pendingPayableTotal = pendingPayables.reduce((sum, t) => sum + parseFloat(t.amount), 0);

      const clientsSummary = clients.length > 0
        ? clients.slice(0, 10).map((c: { name: string }) => c.name).join(', ') + (clients.length > 10 ? ` (+${clients.length - 10} mas)` : '')
        : 'Ninguno registrado';
      const suppliersSummary = suppliers.length > 0
        ? suppliers.slice(0, 10).map((s: { name: string }) => s.name).join(', ') + (suppliers.length > 10 ? ` (+${suppliers.length - 10} mas)` : '')
        : 'Ninguno registrado';
      const employeesSummary = employees.length > 0
        ? employees.slice(0, 10).map((e: { fullName: string }) => e.fullName).join(', ') + (employees.length > 10 ? ` (+${employees.length - 10} mas)` : '')
        : 'Ninguno registrado';

      const financialContext = `
CUENTAS:
- Total: ${accounts.length} cuenta(s), Saldo total: $${totalBalance.toLocaleString('es-AR')}
- Detalle: ${accounts.map((a: { name: string; balance: string | null; currency: string | null }) => `${a.name} (${a.currency || 'ARS'}): $${parseFloat(a.balance || '0').toLocaleString('es-AR')}`).join(', ')}

RESUMEN ${monthNames[currentMonth].toUpperCase()} ${currentYear} (mes actual):
- Total gastos: $${thisMonthExpenses.toLocaleString('es-AR')} (${thisMonthTransactions.filter(t => t.type === 'expense').length} movimientos)
- Total ingresos: $${thisMonthIncome.toLocaleString('es-AR')} (${thisMonthTransactions.filter(t => t.type === 'income').length} movimientos)
- Balance del mes: $${(thisMonthIncome - thisMonthExpenses).toLocaleString('es-AR')}
${topCategories.length > 0 ? `- Top categorias de gasto: ${topCategories.join(', ')}` : ''}

RESUMEN ${monthNames[lastMonthDate.getMonth()].toUpperCase()} ${lastMonthDate.getFullYear()} (mes anterior):
- Total gastos: $${lastMonthExpenses.toLocaleString('es-AR')}
- Total ingresos: $${lastMonthIncome.toLocaleString('es-AR')}

COMPROMISOS PENDIENTES:
- Por cobrar: ${pendingReceivables.length} pendiente(s) por $${pendingReceivableTotal.toLocaleString('es-AR')}
- Por pagar: ${pendingPayables.length} pendiente(s) por $${pendingPayableTotal.toLocaleString('es-AR')}

CLIENTES (${clients.length}): ${clientsSummary}
PROVEEDORES (${suppliers.length}): ${suppliersSummary}
EMPLEADOS (${employees.length}): ${employeesSummary}

ULTIMOS 10 MOVIMIENTOS:
${recentTransactions.slice(0, 10).map(t => {
  const typeLabel = t.type === 'expense' ? 'Gasto' : t.type === 'income' ? 'Ingreso' : t.type === 'receivable' ? 'Por cobrar' : 'Por pagar';
  const statusLabel = t.status === 'completed' ? '' : ` [${t.status}]`;
  return `- ${typeLabel}: ${t.description} $${parseFloat(t.amount).toLocaleString('es-AR')} (${t.category || 'sin cat.'}) ${new Date(t.date).toLocaleDateString('es-AR')}${statusLabel}`;
}).join('\n')}
      `.trim();

      const aiResponse = await generateConversationalResponse(userMessage, historyMessages, financialContext);

      await storage.createChatMessage({
        organizationId,
        userId,
        role: 'assistant',
        content: aiResponse,
      });

      res.json({ message: aiResponse });
    } catch (error: any) {
      console.error('AI Chat error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error en chat de IA' });
    }
  });

  app.post('/api/ai/health-analysis', requireAuth, async (req: any, res) => {
    try {
      const { metrics } = req.body;
      
      if (!metrics) {
        return res.status(400).json({ message: 'Se requieren métricas financieras' });
      }

      const formatAmount = (val: number) => {
        if (Math.abs(val) >= 1_000_000) {
          return `$${(val / 1_000_000).toFixed(2)}M`;
        } else if (Math.abs(val) >= 1_000) {
          return `$${(val / 1_000).toFixed(1)}K`;
        }
        return `$${val.toFixed(0)}`;
      };

      const systemPrompt = `Sos Aike, analista financiero argentino experto en pymes. Analizá la situación financiera y dá consejos concretos.

DATOS FINANCIEROS:
- Puntaje de salud: ${metrics.finalScore}%
- Posición neta: ${formatAmount(metrics.netPosition)} (Disponible + Por Cobrar - Por Pagar)
- Saldo disponible actual: ${formatAmount(metrics.totalBalance)}
- Por cobrar pendiente: ${formatAmount(metrics.pendingReceivable)}
- Por pagar pendiente: ${formatAmount(metrics.pendingPayable)}

DEUDAS POR VENCIMIENTO:
- Vencidas: ${formatAmount(metrics.overduePayablesAmount)}
- Próximos 7 días: ${formatAmount(metrics.payables0to7Amount)}
- 8-15 días: ${formatAmount(metrics.payables8to15Amount)}
- 16-30 días: ${formatAmount(metrics.payables16to30Amount)}

COBROS POR VENCIMIENTO:
- Vencidos sin cobrar: ${formatAmount(metrics.overdueReceivablesAmount)}
- Próximos 7 días: ${formatAmount(metrics.receivables0to7Amount)}
- 8-15 días: ${formatAmount(metrics.receivables8to15Amount)}
- 16-30 días: ${formatAmount(metrics.receivables16to30Amount)}

PROYECCIÓN:
- Balance proyectado a 30 días: ${formatAmount(metrics.projectedBalance30)}

PENALIZACIONES APLICADAS:
${metrics.structuralDeficitPenalty > 0 ? `- Déficit estructural: -${metrics.structuralDeficitPenalty} puntos` : ''}
${metrics.liquidityCrisisPenalty > 0 ? `- Crisis de liquidez: -${metrics.liquidityCrisisPenalty} puntos` : ''}
${metrics.cashFlowPenalty > 0 ? `- Flujo de caja negativo: -${metrics.cashFlowPenalty} puntos` : ''}
${metrics.overduePenalty > 0 ? `- Pagos vencidos: -${metrics.overduePenalty} puntos` : ''}
${metrics.negativePenalty > 0 ? `- Cuentas en negativo: -${metrics.negativePenalty} puntos` : ''}
${metrics.collectionRiskPenalty > 0 ? `- Riesgo de cobranza: -${metrics.collectionRiskPenalty} puntos` : ''}

INSTRUCCIONES:
1. IMPORTANTE: El puntaje oficial es ${metrics.finalScore}%. NO calcules ni menciones otro puntaje distinto.
2. Comenzá con un diagnóstico breve basado en ese ${metrics.finalScore}%:
   - 80-100%: situación excelente/muy buena
   - 60-79%: situación buena con alertas menores
   - 40-59%: situación que requiere atención
   - 20-39%: situación crítica
   - 0-19%: emergencia financiera
3. Identificá los 2-3 problemas más importantes según las penalizaciones aplicadas
4. Dá acciones concretas numeradas que puedan ejecutar esta semana
5. Si la situación es buena (>70%), felicitá y dá consejos para mantenerla
6. Usá lenguaje argentino casual pero profesional
7. Máximo 200 palabras

Respondé solo con el análisis, sin JSON ni puntajes inventados.`;

      const response = await openai.chat.completions.create({
        model: AI_MODELS.ADVANCED,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Analizá mi situación financiera y dame consejos concretos." }
        ],
        max_tokens: 500,
        temperature: 0.7,
      });

      const analysis = response.choices[0]?.message?.content || 'No se pudo generar el análisis.';
      
      res.json({ analysis });
    } catch (error: any) {
      console.error('Health analysis error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error al analizar salud financiera' });
    }
  });

  app.post('/api/ai/analyze-bank-statement', requireAuth, async (req: any, res) => {
    try {
      const { imageBase64, mimeType, accounts } = req.body;
      
      if (!imageBase64) {
        return res.status(400).json({ message: 'Se requiere una imagen del extracto bancario' });
      }

      const maxBase64Size = 5 * 1024 * 1024 * 1.37;
      if (imageBase64.length > maxBase64Size) {
        return res.status(400).json({ message: 'El archivo es demasiado grande. El tamaño máximo es 5 MB.' });
      }

      // Cargar las categorías reales de la organización para que la IA sólo
      // sugiera categorías que el usuario realmente tiene cargadas (incluyendo
      // las personalizadas tipo "Impuesto SIRCREB"). Si la organización todavía
      // no tiene categorías, caemos a la lista genérica histórica.
      const orgCategories = await storage.getTransactionCategoriesByOrganization(req.organizationId);
      const incomeCategoryNames = orgCategories.filter(c => c.type === 'income').map(c => c.name);
      const expenseCategoryNames = orgCategories.filter(c => c.type === 'expense').map(c => c.name);
      const hasOrgCategories = incomeCategoryNames.length > 0 || expenseCategoryNames.length > 0;

      const categoryInstruction = hasOrgCategories
        ? `Categoría sugerida. Elegí EXCLUSIVAMENTE de las listas siguientes, según el tipo del movimiento. Si ninguna calza claramente, devolvé null (no inventes categorías nuevas).
     INGRESO (income): ${incomeCategoryNames.length > 0 ? incomeCategoryNames.join(', ') : '(no hay categorías de ingreso cargadas — devolvé null para income)'}
     EGRESO (expense): ${expenseCategoryNames.length > 0 ? expenseCategoryNames.join(', ') : '(no hay categorías de egreso cargadas — devolvé null para expense)'}`
        : `Categoría sugerida (Ventas, Servicios, Insumos, Alquiler, Sueldos, Impuestos, Logística, Marketing, Otros)`;

      const systemPrompt = `Sos un experto en análisis de extractos bancarios argentinos. Tu tarea es extraer los movimientos de un extracto bancario y convertirlos en transacciones estructuradas.

INSTRUCCIONES:
1. Analizá el extracto bancario (puede ser texto extraído de un PDF o una imagen)
2. Identificá cada movimiento (débito/crédito) con:
   - Fecha de la operación
   - Descripción/concepto
   - Monto (positivo para ingresos/créditos, negativo para egresos/débitos)
   - ${categoryInstruction}
   - Tipo de movimiento (income para créditos, expense para débitos)

3. Respondé ÚNICAMENTE con un JSON válido con esta estructura:
{
  "bankName": "nombre del banco detectado",
  "accountNumber": "número de cuenta si es visible",
  "periodStart": "YYYY-MM-DD",
  "periodEnd": "YYYY-MM-DD",
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "descripción del movimiento",
      "amount": 1234.56,
      "type": "income" | "expense",
      "category": "categoría sugerida",
      "reference": "número de referencia si existe"
    }
  ],
  "summary": {
    "totalCredits": 0,
    "totalDebits": 0,
    "balance": 0
  }
}

NOTAS:
- Montos de crédito son "income", montos de débito son "expense"
- El monto siempre es positivo en el JSON (el tipo indica si es entrada o salida)
- Si no podés leer algo claramente, poné null en ese campo
- Detectá patrones comunes: transferencias, pagos de tarjeta, sueldos, servicios, etc.
- Si el contenido no es un extracto bancario, respondé: {"error": "No se detectó un extracto bancario válido"}`;

      const isPdf = mimeType === 'application/pdf';
      let messages: any[] = [];

      if (isPdf) {
        const pdfBuffer = Buffer.from(imageBase64, 'base64');

        let pdfTextExtracted = '';
        try {
          const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
          const doc = await (pdfjsLib as any).getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
          const pages: string[] = [];
          for (let i = 1; i <= Math.min(doc.numPages, 5); i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map((item: any) => item.str).join(' ');
            pages.push(pageText);
          }
          pdfTextExtracted = pages.join('\n').trim();
        } catch (parseErr: any) {
          console.error('PDF text extraction error:', parseErr.message);
        }

        if (pdfTextExtracted.length > 50) {
          messages = [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Analizá el siguiente texto extraído de un extracto bancario en PDF y extraé todos los movimientos en formato JSON.\n\nTEXTO DEL EXTRACTO:\n${pdfTextExtracted.slice(0, 15000)}`
            }
          ];
        } else {
          let usedImageFallback = false;
          const tempWorkDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pdf_convert_'));

          try {
            const tempPdfPath = path.join(tempWorkDir, 'input.pdf');
            const tempOutputPrefix = path.join(tempWorkDir, 'page');

            await writeFileAsync(tempPdfPath, pdfBuffer);

            await execFileAsync('pdftocairo', [
              '-png', '-r', '200', '-l', '3',
              tempPdfPath, tempOutputPrefix
            ], { timeout: 30000 });

            const dirFiles = await readdirAsync(tempWorkDir);
            const pageFiles = dirFiles
              .filter(f => f.startsWith('page') && f.endsWith('.png'))
              .sort()
              .slice(0, 3);

            if (pageFiles.length > 0) {
              const imageContents: any[] = [];
              imageContents.push({
                type: "text",
                text: pageFiles.length > 1
                  ? `Analizá estas ${pageFiles.length} páginas del extracto bancario y extraé todos los movimientos en formato JSON.`
                  : "Analizá este extracto bancario y extraé todos los movimientos en formato JSON."
              });

              for (const pageFile of pageFiles) {
                const pageBuffer = await readFileAsync(path.join(tempWorkDir, pageFile));
                imageContents.push({
                  type: "image_url",
                  image_url: {
                    url: `data:image/png;base64,${pageBuffer.toString('base64')}`,
                    detail: "high"
                  }
                });
              }

              messages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: imageContents }
              ];
              usedImageFallback = true;
            }
          } catch (convError: any) {
            console.error('PDF image conversion fallback error:', convError.message);
          } finally {
            fs.promises.rm(tempWorkDir, { recursive: true, force: true }).catch(() => {});
          }

          if (!usedImageFallback) {
            return res.status(400).json({ message: 'Este PDF parece ser una imagen escaneada y no se pudo convertir. Probá subiendo una captura de pantalla (JPG o PNG) del extracto.' });
          }
        }
      } else {
        messages = [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`,
                  detail: "high"
                }
              },
              {
                type: "text",
                text: "Analizá este extracto bancario y extraé todos los movimientos en formato JSON."
              }
            ]
          }
        ];
      }

      const response = await openai.chat.completions.create({
        model: AI_MODELS.ADVANCED,
        messages,
        max_tokens: 4000,
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content || '{}';
      
      let result;
      try {
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        result = JSON.parse(cleanContent);
      } catch (parseError) {
        console.error('Failed to parse AI response:', content);
        result = { error: 'No se pudo procesar la respuesta del análisis', raw: content };
      }

      // Normalizar categorías devueltas por el modelo contra las categorías
      // reales de la organización (match case-insensitive por nombre y por
      // tipo). Si no calza ninguna, la dejamos en null para que el humano
      // elija manualmente y no entren categorías "fantasma".
      if (hasOrgCategories && result && Array.isArray(result.transactions)) {
        const incomeMap = new Map(incomeCategoryNames.map(n => [n.toLocaleLowerCase('es-AR'), n]));
        const expenseMap = new Map(expenseCategoryNames.map(n => [n.toLocaleLowerCase('es-AR'), n]));
        for (const tx of result.transactions) {
          if (!tx || typeof tx !== 'object') continue;
          if (tx.type !== 'income' && tx.type !== 'expense') continue;
          const raw = typeof tx.category === 'string' ? tx.category.trim() : '';
          if (!raw) { tx.category = null; continue; }
          const map = tx.type === 'income' ? incomeMap : expenseMap;
          const canonical = map.get(raw.toLocaleLowerCase('es-AR'));
          tx.category = canonical || null;
        }
      }

      res.json(result);
    } catch (error: any) {
      console.error('Bank statement analysis error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error al analizar el extracto bancario' });
    }
  });

  // Interpretar un presupuesto/cotización subido como PDF o foto y devolver sus
  // campos estructurados para precompletar el formulario de "Nuevo presupuesto".
  app.post('/api/ai/analyze-quote', requireAuth, async (req: any, res) => {
    try {
      const { imageBase64, mimeType } = req.body;

      if (!imageBase64) {
        return res.status(400).json({ message: 'Se requiere un archivo del presupuesto' });
      }

      const maxBase64Size = 5 * 1024 * 1024 * 1.37;
      if (imageBase64.length > maxBase64Size) {
        return res.status(400).json({ message: 'El archivo es demasiado grande. El tamaño máximo es 5 MB.' });
      }

      const today = getArgentinaToday();
      const systemPrompt = `Sos un experto en interpretar presupuestos y cotizaciones comerciales de Argentina. Tu tarea es leer el documento (puede ser texto de un PDF o una imagen/foto) y extraer los datos principales del presupuesto.

INSTRUCCIONES:
1. Identificá el presupuesto y extraé:
   - Título o descripción breve de lo presupuestado (ej: "Diseño de sitio web", "Provisión de 100 sillas")
   - Nombre del cliente o destinatario del presupuesto (a quién va dirigido)
   - Monto TOTAL del presupuesto (el total final, IVA incluido si figura como total). Sólo el número.
   - Moneda. Usá uno de estos códigos: ARS, USD, EUR, COP, MXN, CLP, PEN, UYU, BRL. Si ves "$" o pesos argentinos asumí ARS; si ves "U$S", "USD" o dólares asumí USD.
   - Fecha del presupuesto (formato YYYY-MM-DD). La fecha de hoy es ${today} por si hay fechas relativas.
   - Validez / "válido hasta" (formato YYYY-MM-DD) si figura.
   - Notas: armá un resumen ÚTIL del presupuesto. Priorizá en este orden:
     a) El desglose de ítems/conceptos presupuestados con su importe, uno por línea (ej: "Consultoría inicial: USD 1.500\nImplementación: USD 2.000\nSoporte mensual: USD 500").
     b) Condiciones comerciales relevantes: formas/plazos de pago, plazos de entrega, garantías, validez.
     Si no hay desglose ni condiciones, poné null.

2. Respondé ÚNICAMENTE con un JSON válido con esta estructura exacta:
{
  "title": "string o null",
  "clientName": "string o null",
  "amount": 1234.56,
  "currency": "ARS",
  "date": "YYYY-MM-DD o null",
  "validUntil": "YYYY-MM-DD o null",
  "notes": "string o null"
}

NOTAS:
- "amount" siempre como número positivo, sin símbolos ni separadores de miles (usá punto decimal). Si no se puede determinar, poné null.
- Si un dato no aparece claramente en el documento, poné null en ese campo (no inventes).
- En "notes" NO incluyas textos de descargo, disclaimers, leyendas de "documento ficticio", "de demostración", "de ejemplo" o "sin valor", pies de página legales, marcas de agua ni avisos de confidencialidad. Esos textos son irrelevantes: ignoralos por completo.
- Si el contenido NO parece un presupuesto/cotización, respondé exactamente: {"error": "No se detectó un presupuesto válido"}`;

      const built = await buildDocMessages(
        systemPrompt,
        imageBase64,
        mimeType,
        'Analizá este presupuesto y devolvé los datos en formato JSON.',
      );
      if ('error' in built) {
        return res.status(400).json({ message: built.error });
      }

      const response = await openai.chat.completions.create({
        model: AI_MODELS.ADVANCED,
        messages: built.messages,
        max_tokens: 1500,
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content || '{}';
      let result: any;
      try {
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        result = JSON.parse(cleanContent);
      } catch (parseError) {
        console.error('Failed to parse quote AI response:', content);
        result = { error: 'No se pudo procesar la respuesta del análisis' };
      }

      // Normalizar la salida contra el formato del formulario.
      if (result && typeof result === 'object' && !result.error) {
        // Moneda: sólo aceptamos códigos válidos de la app; si no, null (el front cae a ARS).
        if (typeof result.currency === 'string') {
          const up = result.currency.toUpperCase().trim();
          result.currency = (CURRENCIES as readonly string[]).includes(up) ? up : null;
        } else {
          result.currency = null;
        }
        // Monto: aseguramos número finito > 0, o null.
        let amt: number;
        if (typeof result.amount === 'number') {
          amt = result.amount;
        } else if (typeof result.amount === 'string') {
          // Quitar símbolos/espacios. El separador decimal es el que aparezca
          // más a la derecha; el otro se trata como separador de miles.
          // Soporta es-AR "1.234,56" y en-US "1,234.56".
          let s = result.amount.replace(/[^\d.,-]/g, '');
          const lastComma = s.lastIndexOf(',');
          const lastDot = s.lastIndexOf('.');
          if (lastComma > -1 && lastDot > -1) {
            if (lastComma > lastDot) {
              s = s.replace(/\./g, '').replace(',', '.');
            } else {
              s = s.replace(/,/g, '');
            }
          } else if (lastComma > -1) {
            s = s.replace(',', '.');
          }
          amt = parseFloat(s);
        } else {
          amt = NaN;
        }
        result.amount = Number.isFinite(amt) && amt > 0 ? amt : null;
        // Fechas: deben tener formato YYYY-MM-DD, si no null.
        const isISODate = (v: any) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
        if (!isISODate(result.date)) result.date = null;
        if (!isISODate(result.validUntil)) result.validUntil = null;
      }

      res.json(result);
    } catch (error: any) {
      console.error('Quote analysis error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error al analizar el presupuesto' });
    }
  });

  app.post('/api/ai/analyze-transactions', requireAuth, async (req: any, res) => {
    try {
      const transactions = await storage.getTransactionsByOrganization(req.organizationId, undefined, { limit: 200 });
      const accounts = await storage.getAccountsByOrganization(req.organizationId);
      
      if (transactions.length < 5) {
        return res.json({
          insights: [],
          summary: "Necesitás al menos 5 movimientos registrados para un análisis detallado.",
          anomalies: [],
          missingRecurring: [],
          hiddenCosts: []
        });
      }
      
      const txByCategory: Record<string, any[]> = {};
      const txByMonth: Record<string, any[]> = {};
      const categorySums: Record<string, number> = {};
      
      transactions.forEach(tx => {
        const cat = tx.category || 'Otros';
        if (!txByCategory[cat]) txByCategory[cat] = [];
        txByCategory[cat].push(tx);
        categorySums[cat] = (categorySums[cat] || 0) + parseFloat(tx.amount as string);
        
        const date = new Date(tx.date as Date);
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        if (!txByMonth[monthKey]) txByMonth[monthKey] = [];
        txByMonth[monthKey].push(tx);
      });
      
      const totalIncome = transactions.filter(t => t.type === 'income' || t.type === 'receivable').reduce((sum, t) => sum + parseFloat(t.amount as string), 0);
      const totalExpense = transactions.filter(t => t.type === 'expense' || t.type === 'payable').reduce((sum, t) => sum + parseFloat(t.amount as string), 0);
      const avgTransactionAmount = transactions.reduce((sum, t) => sum + parseFloat(t.amount as string), 0) / transactions.length;
      
      const systemPrompt = `Sos Aike, un analista financiero argentino experto en detectar patrones, anomalías y optimizaciones en finanzas de pymes.

DATOS DE TRANSACCIONES (últimos registros):
Total de movimientos: ${transactions.length}
Total ingresos: $${totalIncome.toLocaleString('es-AR')}
Total egresos: $${totalExpense.toLocaleString('es-AR')}
Monto promedio por movimiento: $${avgTransactionAmount.toFixed(0)}

DISTRIBUCIÓN POR CATEGORÍA:
${Object.entries(categorySums).map(([cat, sum]) => `- ${cat}: $${(sum as number).toLocaleString('es-AR')}`).join('\n')}

MOVIMIENTOS POR MES:
${Object.entries(txByMonth).slice(-3).map(([month, txs]) => {
  const income = txs.filter((t: any) => t.type === 'income' || t.type === 'receivable').reduce((s: number, t: any) => s + parseFloat(t.amount), 0);
  const expense = txs.filter((t: any) => t.type === 'expense' || t.type === 'payable').reduce((s: number, t: any) => s + parseFloat(t.amount), 0);
  return `- ${month}: ${txs.length} mov. (Ingreso: $${income.toLocaleString('es-AR')}, Egreso: $${expense.toLocaleString('es-AR')})`;
}).join('\n')}

ÚLTIMOS 10 MOVIMIENTOS:
${transactions.slice(-10).map(t => `- ${t.type}: $${parseFloat(t.amount as string).toLocaleString('es-AR')} - ${t.description} (${t.category})`).join('\n')}

CUENTAS:
${accounts.map(a => `- ${a.name} (${a.type}): $${parseFloat(a.balance).toLocaleString('es-AR')}`).join('\n')}

ANALIZÁ Y RESPONDÉ EN JSON ESTRICTO:
{
  "insights": [
    {
      "type": "pattern" | "anomaly" | "opportunity" | "warning",
      "title": "título corto",
      "description": "descripción detallada",
      "priority": "high" | "medium" | "low",
      "actionable": "acción sugerida"
    }
  ],
  "missingRecurring": [
    {
      "name": "nombre del gasto recurrente probable que falta",
      "estimatedAmount": 1000,
      "frequency": "mensual" | "semanal",
      "reason": "por qué creés que falta"
    }
  ],
  "hiddenCosts": [
    {
      "category": "categoría afectada",
      "issue": "descripción del costo oculto",
      "estimatedImpact": 500,
      "suggestion": "cómo optimizar"
    }
  ],
  "summary": "resumen ejecutivo en 2-3 oraciones"
}

BUSCÁ ESPECÍFICAMENTE:
1. Gastos que deberían ser recurrentes pero no aparecen (ej: si hay alquiler en algunos meses pero no en otros)
2. Categorías con variaciones inusuales (gastos que se duplican, faltan, o varían mucho)
3. Patrones sospechosos (muchos gastos pequeños que podrían ser uno grande)
4. Oportunidades de ahorro (categorías con gasto alto comparado con ingresos)
5. Posibles gastos faltantes típicos de pymes (servicios, impuestos, monotributo, etc.)

IMPORTANTE: Respondé SOLO con el JSON válido, sin texto adicional.`;

      const response = await openai.chat.completions.create({
        model: AI_MODELS.ADVANCED,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Analizá mis transacciones y encontrá patrones, anomalías y oportunidades de optimización." }
        ],
        max_tokens: 2000,
        temperature: 0.3,
      });

      const content = response.choices[0]?.message?.content || '{}';
      
      let result;
      try {
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        result = JSON.parse(cleanContent);
      } catch (parseError) {
        console.error('Failed to parse AI analysis response:', content);
        result = {
          insights: [{ type: 'warning', title: 'Análisis incompleto', description: 'No se pudo procesar el análisis completo', priority: 'low', actionable: 'Intentá nuevamente' }],
          missingRecurring: [],
          hiddenCosts: [],
          summary: 'El análisis no pudo completarse correctamente.'
        };
      }
      
      res.json(result);
    } catch (error: any) {
      console.error('Transaction analysis error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error al analizar transacciones' });
    }
  });

  app.post('/api/ai/help', requireAuth, async (req: any, res) => {
    try {
      const { question } = req.body;
      
      if (!question || typeof question !== 'string') {
        return res.status(400).json({ message: 'Pregunta requerida' });
      }

      const systemPrompt = `Sos Aike, el asistente virtual de Aikestar, un sistema de gestión financiera para pymes argentinas.

Tu ÚNICA función es responder preguntas sobre cómo usar la aplicación Aikestar. 

FUNCIONALIDADES DE AIKESTAR:
- **Cuentas**: Crear cuentas bancarias, cajas de efectivo, billeteras digitales. Cada cuenta tiene una moneda (ARS, USD, USD_CASH, EUR).
- **Movimientos**: Registrar ingresos, egresos, cuentas por cobrar (receivable) y cuentas por pagar (payable). Se pueden adjuntar comprobantes.
- **Clientes**: Gestionar datos de clientes y asociarlos a movimientos de cobro.
- **Proveedores**: Gestionar datos de proveedores y asociarlos a pagos.
- **Productos**: Inventario con nombre, SKU, precio, stock.
- **Reportes**: Estado de resultados, balance, exportar a CSV/PDF, valuación de empresa.
- **IA Aike**: Asistente conversacional para registrar movimientos, analizar salud financiera, leer comprobantes.
- **Equipo**: Invitar colaboradores con roles (Operador, Especialista, Admin).
- **Configuración**: Cambiar contraseña, gestionar organizaciones, tipos de cambio.

REGLAS:
1. Respondé SOLO sobre cómo usar Aikestar.
2. Si la pregunta NO es sobre Aikestar, respondé: "Solo puedo ayudarte con preguntas sobre cómo usar Aikestar."
3. Usá español rioplatense (vos, querés, podés).
4. Sé conciso y directo (máximo 3-4 oraciones).
5. Si corresponde, indicá la ruta de navegación (ej: "Ve a Oficina > Clientes").`;

      const response = await openai.chat.completions.create({
        model: AI_MODELS.ADVANCED,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question }
        ],
        max_tokens: 300,
        temperature: 0.3,
      });

      const answer = response.choices[0]?.message?.content || 'No pude procesar tu pregunta.';
      res.json({ answer });
    } catch (error: any) {
      console.error('AI help error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error al procesar la consulta' });
    }
  });

  // Support contact endpoint
  app.post('/api/support', requireAuth, async (req: any, res) => {
    try {
      const { subject, message, contactEmail } = req.body;
      const userId = req.userId;
      
      // Defensive guard: ensure userId is present before querying storage
      if (!userId) {
        console.warn('[Support] Missing userId in authenticated request');
        return res.status(401).json({ message: 'Usuario no autenticado' });
      }
      
      if (!subject || typeof subject !== 'string' || subject.trim().length < 3) {
        return res.status(400).json({ message: 'El asunto es requerido (mínimo 3 caracteres)' });
      }
      
      if (!message || typeof message !== 'string' || message.trim().length < 10) {
        return res.status(400).json({ message: 'El mensaje es requerido (mínimo 10 caracteres)' });
      }

      // Validate optional contact email if provided
      if (contactEmail && typeof contactEmail === 'string' && contactEmail.trim()) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(contactEmail.trim())) {
          return res.status(400).json({ message: 'El email de contacto no es válido' });
        }
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(401).json({ message: 'Usuario no encontrado' });
      }

      // Use contact email if provided, otherwise use user's account email
      const replyToEmail = (contactEmail && contactEmail.trim()) ? contactEmail.trim() : user.email;

      let organizationName: string | undefined;
      if (req.organization?.id) {
        const org = await storage.getOrganization(req.organization.id);
        organizationName = org?.name;
      }

      const { sendSupportEmail } = await import('../services/email');
      const sent = await sendSupportEmail(
        user.email,
        user.name,
        subject.trim(),
        message.trim(),
        organizationName,
        replyToEmail
      );

      if (sent) {
        res.json({ success: true, message: 'Tu mensaje fue enviado a soporte. Te responderemos pronto.' });
      } else {
        res.status(500).json({ message: 'No se pudo enviar el mensaje. Intentá de nuevo o escribí directamente a soporte@aikestar.net' });
      }
    } catch (error: any) {
      console.error('Support email error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error al enviar el mensaje' });
    }
  });

  app.post('/api/reports/ai', requireAuth, async (req: any, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
        return res.status(400).json({ message: 'Escribí una descripción del reporte que necesitás.' });
      }

      const [txs, accs, cls, sups, prods] = await Promise.all([
        storage.getTransactionsByOrganization(req.organizationId),
        storage.getAccountsByOrganization(req.organizationId),
        storage.getClientsByOrganization(req.organizationId),
        storage.getSuppliersByOrganization(req.organizationId),
        storage.getProductsByOrganization(req.organizationId),
      ]);

      const aggregated: Record<string, { income: number; expense: number; count: number }> = {};
      const byCurrency: Record<string, { income: number; expense: number }> = {};
      const byClient: Record<string, { total: number; count: number; name: string }> = {};
      const bySupplier: Record<string, { total: number; count: number; name: string }> = {};

      const clientMap = new Map(cls.map(c => [c.id, c.name]));
      const supplierMap = new Map(sups.map(s => [s.id, s.name]));

      for (const t of txs) {
        const cat = t.category || 'Sin categoría';
        const amt = parseFloat(String(t.amount)) || 0;
        const curr = t.currency || 'ARS';

        if (!aggregated[cat]) aggregated[cat] = { income: 0, expense: 0, count: 0 };
        if (!byCurrency[curr]) byCurrency[curr] = { income: 0, expense: 0 };

        aggregated[cat].count++;
        if (t.type === 'income' || t.type === 'receivable') {
          aggregated[cat].income += amt;
          byCurrency[curr].income += amt;
        } else {
          aggregated[cat].expense += amt;
          byCurrency[curr].expense += amt;
        }

        if (t.clientId) {
          const cName = clientMap.get(t.clientId) || t.clientId;
          if (!byClient[t.clientId]) byClient[t.clientId] = { total: 0, count: 0, name: cName };
          byClient[t.clientId].total += amt;
          byClient[t.clientId].count++;
        }
        if (t.supplierId) {
          const sName = supplierMap.get(t.supplierId) || t.supplierId;
          if (!bySupplier[t.supplierId]) bySupplier[t.supplierId] = { total: 0, count: 0, name: sName };
          bySupplier[t.supplierId].total += amt;
          bySupplier[t.supplierId].count++;
        }
      }

      const recentTxs = txs.slice(0, 50).map(t => ({
        tipo: t.type,
        monto: t.amount,
        moneda: t.currency,
        desc: t.description,
        cat: t.category,
        fecha: t.date ? new Date(t.date).toISOString().split('T')[0] : null,
        estado: t.status,
      }));

      const dataContext = JSON.stringify({
        resumenPorCategoria: aggregated,
        resumenPorMoneda: byCurrency,
        resumenPorCliente: Object.values(byClient),
        resumenPorProveedor: Object.values(bySupplier),
        transaccionesRecientes: recentTxs,
        totalTransacciones: txs.length,
        cuentas: accs.map(a => ({ nombre: a.name, tipo: a.type, cat: a.accountCategory, saldo: a.balance, moneda: a.currency })),
        clientes: cls.map(c => ({ nombre: c.name, email: c.email })),
        proveedores: sups.map(s => ({ nombre: s.name })),
        productos: prods.map(p => ({ nombre: p.name, sku: p.sku, precio: p.salePrice, stock: p.stock })),
      });

      const systemPrompt = `Sos un analista financiero experto que genera reportes para PyMEs argentinas. 
El usuario te va a pedir un tipo de reporte. Usá los datos agregados y recientes que te paso para generar el reporte.

REGLAS CRÍTICAS DE FORMATO:
- Respondé ÚNICAMENTE con un objeto JSON válido.
- El JSON debe tener esta estructura exacta:
{"titulo":"Título del reporte","resumen":"Resumen ejecutivo breve (máximo 2 oraciones)","columnas":["Col1","Col2","Col3"],"filas":[["val1","val2","val3"]],"insights":["Obs 1","Obs 2"]}

REGLAS DE CONTENIDO:
- Español argentino
- Datos concretos extraídos de los datos reales
- Montos formateados estilo argentino (punto miles, coma decimales)
- Si no hay datos suficientes, explicalo en el resumen y dejá filas como []
- MÁXIMO 20 filas, MÁXIMO 4 insights de 1 oración cada uno
- Resumen BREVE: máximo 2 oraciones
- NO inventes datos
- JSON COMPACTO`;

      // Genera el reporte con Claude (modelo ADVANCED). Devuelve el JSON parseado.
      const callClaude = async (data: string, userPrompt: string): Promise<any> => {
        const completion = await openai.chat.completions.create({
          model: AI_MODELS.ADVANCED,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `DATOS:\n${data}\n\nREPORTE: ${userPrompt}` },
          ],
          max_tokens: 8192,
          response_format: { type: 'json_object' },
        });

        const rawText = completion.choices[0]?.message?.content?.trim() || '';
        console.log(`[AI Reports] responseLength: ${rawText.length}`);

        if (!rawText) {
          throw new Error('EMPTY_RESPONSE');
        }

        let cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          cleaned = jsonMatch[0];
        }

        if (!cleaned.endsWith('}')) {
          throw new Error('TRUNCATED');
        }

        return JSON.parse(cleaned);
      }

      let reportData;
      try {
        reportData = await callClaude(dataContext, prompt.trim());
      } catch (err: any) {
        if (err.message === 'TRUNCATED' || err.message === 'SyntaxError' || err instanceof SyntaxError) {
          console.warn('[AI Reports] First attempt truncated/failed, retrying with reduced data...');
          const reducedContext = JSON.stringify({
            resumenPorCategoria: aggregated,
            resumenPorMoneda: byCurrency,
            totalTransacciones: txs.length,
            cuentas: accs.map(a => ({ nombre: a.name, saldo: a.balance, moneda: a.currency })),
          });
          try {
            reportData = await callClaude(reducedContext, prompt.trim() + ' (usá máximo 10 filas y sé muy conciso)');
          } catch (retryErr: any) {
            console.error('[AI Reports] Retry also failed:', retryErr.message);
            return res.status(500).json({ message: 'No se pudo generar el reporte. Intentá con una consulta más específica (ej: "gastos por categoría" en vez de "resumen de todo").' });
          }
        } else if (err.message === 'EMPTY_RESPONSE') {
          return res.status(500).json({ message: 'La IA no generó una respuesta. Intentá de nuevo.' });
        } else if (err.message === 'API_ERROR') {
          return res.status(500).json({ message: 'Error al conectar con el servicio de IA.' });
        } else {
          console.error('[AI Reports] Parse error:', err.message);
          return res.status(500).json({ message: 'No se pudo interpretar la respuesta de la IA. Intentá con otra descripción.' });
        }
      }

      if (!reportData?.titulo || !reportData?.columnas || !Array.isArray(reportData?.filas)) {
        return res.status(500).json({ message: 'La IA no generó un reporte válido. Probá con una descripción más específica.' });
      }

      res.json(reportData);
    } catch (error: any) {
      console.error('[AI Reports] Error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error al generar el reporte' });
    }
  });
}
