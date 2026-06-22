import type { Express, Request, Response } from "express";
import OpenAI from "../lib/claude";
import { Readable } from "stream";
import { AsyncLocalStorage } from "node:async_hooks";
import { storage } from "../storage";
import { requireAuth, type AuthenticatedRequest } from "./middleware";
import { resolveWhatsappOrgId } from "../lib/resolveWhatsappOrgId";
import {
  shouldShowOrgBanner,
  buildOrgBannerMessage,
  detectShowCurrentOrgRequest,
  resolveOrgBannerGapMs,
} from "../lib/whatsappSessionState";
import { AI_MODELS, getArgentinaToday } from "@shared/constants";
import type { InsertDashboardPreferences } from "@shared/schema";
import { normalizePhoneInput } from "@shared/phone";
import { 
  getOrCreateConversation,
  peekConversation,
  updateConversation, 
  resetConversation, 
  clearConversation,
  getNextStep, 
  suggestAccounts, 
  formatAccountSuggestions,
  isGenericDescription,
  findActiveConversationOrgId,
  acquireWhatsappLock,
  type TransactionSlots,
  type ConversationState,
  type SlotSource,
  type WhatsappLockHandle,
} from "../conversation-state";
import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import { randomUUID } from "crypto";
import { analyzeUserPatterns, clearPatternCache, type PatternSuggestion } from "../user-patterns";
import { autoApplyPaymentToCommitments } from "../services/autoApply";
import { validateTransactionCategory } from "../services/categoryValidation";
import { getBotPhoneInfo } from "../lib/botPhone";

const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER 
  ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace('whatsapp:', '')}`
  : "whatsapp:+14155238886";

// Capitalize first letter of a string
function capitalizeFirst(str: string): string {
  if (!str || str.length === 0) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Persiste la última actividad por WhatsApp del usuario (Task #211).
// Antes vivía en un Map in-memory en `whatsappSessionState`, así que se
// reseteaba con cada deploy/reinicio y el banner de org activa volvía a
// dispararse de más. Ahora vive en `users.lastWhatsappMessageAt`.
// Si la escritura falla, el peor caso es un banner extra en el próximo
// mensaje — no rompemos el handler por esto.
// Día calendario de HOY en hora de Argentina, fijado al mediodía. El servidor
// corre en UTC, así que `new Date()` usado como fecha del movimiento dejaba los
// movimientos cargados de noche (UTC-3) con la fecha del día siguiente. Esto
// devuelve el mismo valor que produce la app (mediodía del día argentino), para
// que un movimiento cargado por el bot quede con la fecha correcta.
function argentinaTodayAtNoon(): Date {
  return new Date(`${getArgentinaToday()}T12:00:00`);
}

async function markUserSeen(userId: string, now: Date = new Date()): Promise<void> {
  try {
    await storage.updateUser(userId, { lastWhatsappMessageAt: now });
  } catch (err) {
    console.error('[WhatsApp] Failed to persist lastWhatsappMessageAt:', err);
  }
}

interface SmartSlotSources {
  account?: SlotSource;
  category?: SlotSource;
  hasInvoice?: SlotSource;
}

function buildAccountLabel(accountName: string, source?: string): string {
  if (source === 'pattern') return `🏦 ${accountName} _(habitual)_`;
  if (source === 'preference') return `🏦 ${accountName} _(preferida)_`;
  return `🏦 ${accountName}`;
}

function buildCategoryLabel(category: string, source?: string): string {
  if (source === 'pattern') return `📁 ${category} _(habitual)_`;
  if (source === 'preference') return `📁 ${category} _(preferida)_`;
  if (category === 'General') return '';
  return `📁 ${category}`;
}

function hasInferredDefaults(sources: SmartSlotSources): boolean {
  return sources.account === 'pattern' || sources.account === 'preference' ||
    sources.category === 'pattern' || sources.category === 'preference' ||
    sources.hasInvoice === 'pattern' || sources.hasInvoice === 'preference';
}

function buildInvoiceLabel(hasInvoice: boolean, source?: string): string {
  const base = hasInvoice ? 'Con factura' : 'Sin factura';
  if (source === 'pattern') return `🧾 ${base} _(habitual)_`;
  if (source === 'preference') return `🧾 ${base} _(preferida)_`;
  return `🧾 ${base}`;
}

/**
 * Task #286 — Resuelve una categoría válida del catálogo de la org para usar en
 * la inserción del bot. La columna `transactions.category` es `NOT NULL` en la
 * base; antes el bot insertaba `null` cuando la AI inventaba una categoría
 * inexistente (ej. "General") y el INSERT explotaba con 23502, dejando al
 * usuario sin respuesta. Ahora siempre devolvemos un nombre que existe en el
 * catálogo:
 *   1) si `requested` matchea el catálogo → devuelve canonical
 *   2) si no matchea pero la org tiene categorías del tipo → primera disponible
 *   3) si la org no tiene ninguna → seed defaults y volver a elegir la primera
 *   4) en último caso (no debería pasar) → fallback constante ("Otros gastos"/"Otros ingresos")
 * Transfers se devuelven tal cual (server-generated labels).
 */
export async function resolveCategoryForWhatsApp(
  organizationId: string,
  type: string,
  requested: string | null | undefined,
  userId: string,
): Promise<string> {
  if (type === 'transfer_in' || type === 'transfer_out') {
    return typeof requested === 'string' && requested.trim().length > 0
      ? requested.trim()
      : 'Transferencia interna';
  }

  // catType: receivable usa income; payable usa expense.
  const catType: 'income' | 'expense' =
    type === 'income' || type === 'receivable' ? 'income' : 'expense';

  // 1) Si el input es válido contra el catálogo, devolver canonical.
  if (requested && requested.trim().length > 0) {
    const v = await validateTransactionCategory(organizationId, type, requested);
    if (v.ok && v.canonical) {
      return v.canonical;
    }
    console.warn(
      `[WhatsApp] Categoría "${requested}" inválida para ${catType} en org ${organizationId}; aplicando fallback.`,
    );
  }

  // 2) Primera categoría existente de la org compatible con el tipo.
  let rows = await storage.getTransactionCategoriesByOrganization(organizationId, catType);
  if (rows.length === 0) {
    // 3) Org sin catálogo: sembrar defaults y reintentar.
    try {
      console.warn(
        `[WhatsApp] Org ${organizationId} sin categorías ${catType}; sembrando defaults.`,
      );
      await storage.seedDefaultCategories(organizationId, userId);
      rows = await storage.getTransactionCategoriesByOrganization(organizationId, catType);
    } catch (err) {
      console.error('[WhatsApp] seedDefaultCategories falló:', err);
    }
  }
  if (rows.length > 0) {
    // Preferimos una categoría "generalista" si existe (Otros ingresos /
    // Otros gastos), si no la primera. Es determinístico y evita que el bot
    // termine clasificando un café como "Sueldos" al azar.
    const preferredName = catType === 'income' ? 'Otros ingresos' : 'Otros gastos';
    const preferred = rows.find(r => r.name.toLowerCase() === preferredName.toLowerCase());
    return (preferred || rows[0]).name;
  }

  // 4) Último cartucho — nunca debería llegar acá si la org existe.
  return catType === 'income' ? 'Otros ingresos' : 'Otros gastos';
}

export async function createWhatsAppTransaction(txData: Parameters<typeof storage.createTransaction>[0], userId: string) {
  // Task #286: nunca insertamos `category = null` (la columna es NOT NULL en
  // la base y un null hacía que el bot quedara mudo). Resolvemos siempre a
  // una categoría válida del catálogo de la org. Transfers son exentos.
  if (txData.type !== 'transfer_in' && txData.type !== 'transfer_out') {
    txData.category = await resolveCategoryForWhatsApp(
      txData.organizationId,
      txData.type,
      txData.category,
      userId,
    );
  }
  let created;
  try {
    created = await storage.createTransaction(txData);
  } catch (err: any) {
    // Defensa en profundidad: si igual la base devuelve NOT NULL violation
    // por category (p. ej. drift schema/DB), reintentamos una vez con un
    // fallback bulletproof para no perder la transacción del usuario.
    if (
      err?.code === '23502' &&
      typeof err?.column === 'string' &&
      err.column.toLowerCase() === 'category' &&
      txData.type !== 'transfer_in' &&
      txData.type !== 'transfer_out'
    ) {
      const catType: 'income' | 'expense' =
        txData.type === 'income' || txData.type === 'receivable' ? 'income' : 'expense';
      txData.category = catType === 'income' ? 'Otros ingresos' : 'Otros gastos';
      console.error(
        `[WhatsApp] 23502 en transactions.category; reintentando con fallback "${txData.category}".`,
      );
      created = await storage.createTransaction(txData);
    } else {
      throw err;
    }
  }
  try {
    const isExpenseWithSupplier = created.type === 'expense' && created.supplierId;
    const isIncomeWithClient = created.type === 'income' && created.clientId;
    if (isExpenseWithSupplier) {
      const result = await autoApplyPaymentToCommitments({
        paymentAmount: parseFloat(created.amount),
        currency: created.currency || 'ARS',
        organizationId: created.organizationId,
        userId,
        entityType: 'supplier',
        entityId: created.supplierId!,
        paymentTransactionId: created.id,
      });
      if (result.appliedCount > 0) {
        console.log(`[WhatsApp AutoApply] Applied ${result.appliedCount} payable(s), total: ${result.appliedTotal}`);
      }
    } else if (isIncomeWithClient) {
      const result = await autoApplyPaymentToCommitments({
        paymentAmount: parseFloat(created.amount),
        currency: created.currency || 'ARS',
        organizationId: created.organizationId,
        userId,
        entityType: 'client',
        entityId: created.clientId!,
        paymentTransactionId: created.id,
      });
      if (result.appliedCount > 0) {
        console.log(`[WhatsApp AutoApply] Applied ${result.appliedCount} receivable(s), total: ${result.appliedTotal}`);
      }
    }
  } catch (error) {
    console.error('[WhatsApp AutoApply] Error:', error);
  }
  return created;
}

// Task #379: lee la categoría a partir del CONTENIDO del texto (mensaje/
// descripción, ya sea tipeado o transcripto de un audio) y la mapea contra el
// catálogo REAL de la organización. Devuelve el nombre canónico de una
// categoría existente, o null si nada encaja con claridad (en ese caso el
// llamador cae a la inferencia por patrón/preferencia). Nunca inventa
// categorías fuera del catálogo.
async function pickCategoryFromText(
  organizationId: string,
  type: string,
  text: string | null | undefined,
): Promise<string | null> {
  if (type === 'transfer_in' || type === 'transfer_out') return null;
  if (!text || text.trim().length === 0) return null;

  const catType: 'income' | 'expense' =
    type === 'income' || type === 'receivable' ? 'income' : 'expense';

  let rows;
  try {
    rows = await storage.getTransactionCategoriesByOrganization(organizationId, catType);
  } catch (error) {
    console.error('[WhatsApp] pickCategoryFromText: error cargando catálogo:', error);
    return null;
  }
  if (!rows || rows.length === 0) return null;

  const names = rows.map(r => r.name);
  const openai = getOpenAIClient();
  if (!openai) return null;

  try {
    const response = await openai.chat.completions.create({
      model: AI_MODELS.ADVANCED,
      messages: [
        {
          role: 'system',
          content: `Sos un clasificador de movimientos financieros para un negocio argentino.
Te paso una descripción de un movimiento y la lista EXACTA de categorías disponibles.
Elegí la categoría de la lista que mejor describa el movimiento.

REGLAS:
- Respondé SOLO con el nombre EXACTO de una categoría de la lista (copiado tal cual), o la palabra NINGUNA.
- Si la descripción es genérica o no alcanza para decidir con confianza (ej: "gasto", "pago", "movimiento"), respondé NINGUNA.
- No inventes categorías que no estén en la lista.

Categorías disponibles:
${names.map(n => `- ${n}`).join('\n')}`,
        },
        {
          role: 'user',
          content: text.trim(),
        },
      ],
      temperature: 0,
      max_tokens: 30,
    });

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) return null;
    const cleaned = raw.replace(/^["'`]+|["'`.]+$/g, '').trim();
    if (cleaned.toLocaleLowerCase('es-AR') === 'ninguna') return null;

    const exact = names.find(n => n.toLocaleLowerCase('es-AR') === cleaned.toLocaleLowerCase('es-AR'));
    if (exact) return exact;
    return null;
  } catch (error) {
    console.error('[WhatsApp] pickCategoryFromText: error de IA:', error);
    return null;
  }
}

export async function resolveSmartDefaults(
  userId: string,
  organizationId: string,
  type: string,
  description?: string | null,
  extractedInvoice?: boolean | null,
  extractedAccountId?: string | null,
  accounts?: Array<{ id: string; name: string; currency?: string | null }>,
  existingCategory?: string | null,
): Promise<{ category: string; hasInvoice: boolean; accountId?: string; accountName?: string; sources: SmartSlotSources }> {
  const sources: SmartSlotSources = {};
  let category = existingCategory || 'General';
  let hasInvoice = false;
  let accountId = extractedAccountId || undefined;
  let accountName: string | undefined;

  const invoiceExplicit = extractedInvoice !== null && extractedInvoice !== undefined;
  if (invoiceExplicit) {
    hasInvoice = extractedInvoice!;
    sources.hasInvoice = 'explicit';
  }

  // Task #379: si todavía no hay categoría explícita, intentamos leerla del
  // CONTENIDO del texto (lo que el usuario realmente dijo/escribió/dictó) y
  // mapearla al catálogo de la org. Esto tiene prioridad sobre la inferencia
  // por patrón histórico o preferencia: si el usuario contó de qué se trata,
  // respetamos eso en vez de clasificar todo en la misma categoría "habitual".
  if (category === 'General' && description && description.trim().length > 0) {
    try {
      const fromMessage = await pickCategoryFromText(organizationId, type, description);
      if (fromMessage) {
        category = fromMessage;
        sources.category = 'explicit';
      }
    } catch (error) {
      console.error('[WhatsApp] Error leyendo categoría del mensaje:', error);
    }
  }

  try {
    const patterns = await analyzeUserPatterns(userId, organizationId, type, description || undefined);

    if (category === 'General' && patterns.category && patterns.confidence.category >= 0.70) {
      category = patterns.category;
      sources.category = patterns.source.category || 'pattern';
    }

    if (!invoiceExplicit && patterns.hasInvoice !== undefined && patterns.confidence.hasInvoice >= 0.90) {
      hasInvoice = patterns.hasInvoice;
      sources.hasInvoice = patterns.source.hasInvoice || 'pattern';
    } else if (!invoiceExplicit) {
      hasInvoice = false;
      sources.hasInvoice = 'auto';
    }

    if (!extractedAccountId && patterns.accountId && patterns.confidence.account >= 0.45 && accounts) {
      const patternAccount = accounts.find(a => a.id === patterns.accountId);
      if (patternAccount) {
        accountId = patternAccount.id;
        accountName = patternAccount.name;
        sources.account = patterns.source.account || 'pattern';
      }
    }
  } catch (error) {
    console.error('[WhatsApp] Error resolving smart defaults:', error);
    if (!invoiceExplicit) {
      hasInvoice = false;
      sources.hasInvoice = 'auto';
    }
  }

  if (!sources.category) sources.category = category !== 'General' ? 'explicit' : 'auto';

  // Task #286: garantizamos que la categoría devuelta SIEMPRE exista en el
  // catálogo de la org. Así el resumen pre-confirmación que se le muestra al
  // usuario ya refleja la categoría real que se va a persistir cuando diga
  // "sí", y no una etiqueta inventada por la IA que después sería reescrita.
  try {
    const resolved = await resolveCategoryForWhatsApp(organizationId, type, category, userId);
    if (resolved && resolved !== category) {
      category = resolved;
      sources.category = 'auto';
    } else if (resolved) {
      category = resolved;
    }
  } catch (error) {
    console.error('[WhatsApp] Error resolviendo categoría a catálogo:', error);
  }

  return { category, hasInvoice, accountId, accountName, sources };
}

function composeDescription(
  rawDescription: string | null,
  type: string | null,
  clientName: string | null,
  supplierName: string | null,
): string {
  if (rawDescription && !isGenericDescription(rawDescription)) {
    return rawDescription;
  }
  const typeLabels: Record<string, string> = {
    income: 'Cobro', expense: 'Pago', receivable: 'Por cobrar', payable: 'Por pagar',
  };
  const label = (type && typeLabels[type]) || rawDescription || 'Movimiento';
  if (clientName) return `${label} de ${clientName}`;
  if (supplierName) return `${label} a ${supplierName}`;
  return rawDescription || label;
}

// Get greeting based on Argentina time (UTC-3)
function getArgentinaGreeting(): string {
  const now = new Date();
  // Argentina is UTC-3
  const argentinaHour = (now.getUTCHours() - 3 + 24) % 24;
  
  if (argentinaHour >= 6 && argentinaHour < 12) {
    return 'Buenos días';
  } else if (argentinaHour >= 12 && argentinaHour < 20) {
    return 'Buenas tardes';
  } else {
    return 'Buenas noches';
  }
}

// Get contextual response when user says "no" after completing a transaction
function getPostTransactionNoResponse(): string {
  const responses = [
    '¡Perfecto! Si necesitás algo más, acá estoy 😊',
    '¡Genial! Cualquier cosa me avisás 👍',
    '¡Listo! Cuando quieras registrar algo, escribime 😊',
    '¡Dale! Acá quedo por si necesitás algo más 👋',
  ];
  return responses[Math.floor(Math.random() * responses.length)];
}

// Generate organization header for WhatsApp messages
function getOrgHeader(orgName: string | null): string {
  if (!orgName) return '📍 *Cuenta Personal*';
  return `📍 *${orgName}*`;
}

// Helper para resolver la org del bot — vive en `server/lib/` para poder ser
// importado desde tests sin arrastrar todo el bot (storage, openai, etc.).
// Ver doc completa en `server/lib/resolveWhatsappOrgId.ts`.

// Generate welcome message for first-time WhatsApp users
function getWelcomeMessage(userName: string, orgName: string): string {
  const displayName = userName.split(' ')[0]; // First name only
  return `🎉 *¡Hola ${displayName}! Bienvenido/a a Aike*

Acá podés gestionar tus finanzas por WhatsApp.

*Lo que podés hacer:*
📝 Registrar gastos e ingresos
📊 Ver resumen y saldos
🔄 Cambiar de organización (escribí "cambiar organización" o el nombre directamente)
📋 Ver últimos movimientos (escribí "movimientos")

*Ejemplos:*
• "Gasté 5000 en luz"
• "Cobré 20000"
• "Resumen"
• "Mi Empresa" (para cambiar a esa org)

${getOrgHeader(orgName)}

¿En qué te ayudo?`;
}

// Generate greeting message for returning users
function getGreetingMessage(userName: string, orgName: string): string {
  const displayName = userName.split(' ')[0]; // First name only
  const greeting = getArgentinaGreeting();
  return `${getOrgHeader(orgName)}

¡${greeting} ${displayName}! ¿En qué te ayudo?`;
}

console.log('[WhatsApp] Module loaded. WhatsApp sender number:', TWILIO_WHATSAPP_NUMBER);

// Cliente Claude con interfaz compatible OpenAI (ver server/lib/claude.ts).
// La transcripción de audio sigue usando Gemini aparte (Claude no transcribe audio).
function getOpenAIClient(): OpenAI | null {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[WhatsApp] ANTHROPIC_API_KEY not configured');
    return null;
  }
  return new OpenAI();
}

async function saveWhatsAppImageToStorage(mediaUrl: string, organizationId: string, userId: string): Promise<string> {
  const creds = getTwilioCredentials();
  if (!creds) {
    throw new Error('Twilio credentials not available');
  }
  
  // Download image from Twilio (requires auth)
  const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
  const imageResponse = await fetch(mediaUrl, {
    headers: { 'Authorization': `Basic ${auth}` }
  });
  
  if (!imageResponse.ok) {
    throw new Error(`Failed to download image from Twilio: ${imageResponse.status}`);
  }
  
  const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
  const extension = contentType.includes('png') ? 'png' : contentType.includes('pdf') ? 'pdf' : 'jpg';
  const imageBuffer = await imageResponse.arrayBuffer();
  
  // Upload to Object Storage
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) {
    throw new Error('PRIVATE_OBJECT_DIR not configured');
  }
  
  const fileId = randomUUID();
  const fileName = `invoices/${organizationId}/${fileId}.${extension}`;
  const fullPath = `${privateDir}/${fileName}`;
  
  // Parse bucket and object name from path
  const pathParts = fullPath.split('/').filter(p => p);
  const bucketName = pathParts[0];
  const objectName = pathParts.slice(1).join('/');
  
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  
  await file.save(Buffer.from(imageBuffer), {
    contentType,
    metadata: {
      organizationId,
      userId,
      source: 'whatsapp'
    }
  });
  
  console.log(`[WhatsApp] Saved invoice image: ${fileName}`);
  
  // Return the internal path for storing in DB
  return `/objects/${fileName}`;
}

// Transcribe audio from WhatsApp using Gemini (supports audio natively)
async function transcribeAudio(mediaUrl: string, contentType?: string): Promise<string | null> {
  const creds = getTwilioCredentials();
  if (!creds) {
    console.error('[WhatsApp] Cannot transcribe audio - no Twilio credentials');
    return null;
  }
  
  const geminiApiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  const geminiBaseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  
  if (!geminiApiKey) {
    console.error('[WhatsApp] Gemini API key not configured');
    return null;
  }
  
  try {
    console.log(`[WhatsApp] Downloading audio from: ${mediaUrl}`);
    console.log(`[WhatsApp] Content-Type header: ${contentType}`);
    
    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
    const audioResponse = await fetch(mediaUrl, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    
    if (!audioResponse.ok) {
      const errorText = await audioResponse.text().catch(() => 'unknown');
      console.error(`[WhatsApp] Failed to download audio: ${audioResponse.status} - ${errorText}`);
      return null;
    }
    
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    console.log(`[WhatsApp] Downloaded audio, size: ${audioBuffer.byteLength} bytes`);
    
    if (audioBuffer.byteLength < 1000) {
      console.error(`[WhatsApp] Audio file too small (${audioBuffer.byteLength} bytes), likely corrupt`);
      return null;
    }
    
    if (audioBuffer.byteLength > 8 * 1024 * 1024) {
      console.error(`[WhatsApp] Audio file too large (${audioBuffer.byteLength} bytes), max 8MB for inline data`);
      return null;
    }
    
    const actualContentType = audioResponse.headers.get('content-type') || contentType || 'audio/ogg';
    console.log(`[WhatsApp] Raw content type: ${actualContentType}`);
    
    let mimeType = actualContentType.split(';')[0].trim();
    
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) {
      mimeType = 'audio/mp3';
    } else if (mimeType.includes('mp4') || mimeType.includes('m4a')) {
      mimeType = 'audio/mp4';
    } else if (mimeType.includes('wav')) {
      mimeType = 'audio/wav';
    } else if (mimeType.includes('webm')) {
      mimeType = 'audio/webm';
    } else if (mimeType.includes('flac')) {
      mimeType = 'audio/flac';
    } else if (mimeType.includes('aac')) {
      mimeType = 'audio/aac';
    } else {
      mimeType = 'audio/ogg';
    }
    
    console.log(`[WhatsApp] Normalized mimeType for Gemini: ${mimeType}`);
    
    const audioBase64 = audioBuffer.toString('base64');
    
    const geminiUrl = `${geminiBaseUrl}/models/gemini-2.5-flash:generateContent`;
    console.log(`[WhatsApp] Sending audio to Gemini for transcription via: ${geminiUrl}`);
    
    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': geminiApiKey,
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: 'Transcribí exactamente lo que dice este audio en español. Solo devolvé el texto transcripto, sin explicaciones, sin comillas, sin formato adicional. Si no se entiende el audio, respondé "INAUDIBLE".' },
            {
              inlineData: {
                mimeType: mimeType,
                data: audioBase64
              }
            }
          ]
        }]
      })
    });
    
    if (!geminiResponse.ok) {
      const errorBody = await geminiResponse.text().catch(() => 'unknown');
      console.error(`[WhatsApp] Gemini API error: ${geminiResponse.status} - ${errorBody}`);
      return null;
    }
    
    const geminiResult = await geminiResponse.json() as any;
    const transcription = geminiResult?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    console.log(`[WhatsApp] Gemini transcription result: "${transcription}"`);
    
    if (!transcription || transcription === 'INAUDIBLE' || transcription.length === 0) {
      console.log('[WhatsApp] Transcription returned empty or inaudible');
      return null;
    }
    
    return transcription;
  } catch (error: any) {
    console.error('[WhatsApp] Error transcribing audio with Gemini:', error?.message || error);
    return null;
  }
}

// Task #290 — Lectura de fotos de ticket sueltas por WhatsApp.
// Cuando el usuario manda una foto de comprobante SIN estar en el paso
// `invoice_image`, queremos extraer monto/descripción/categoría sugerida
// con GPT-4o vision y alimentar el flujo normal de creación, en lugar de
// quedarnos mudos. Esta función baja la imagen de Twilio (Basic auth,
// mismo patrón que `saveWhatsAppImageToStorage`) y la manda al modelo
// avanzado pidiendo JSON estricto. Si el modelo decide que no es un
// comprobante (`isReceipt: false`) o no logramos parsear, devolvemos
// `null` y el handler manda un mensaje amistoso pidiendo otra foto.
export interface ExtractedTicket {
  isReceipt: boolean;
  type: 'income' | 'expense';
  amount: number | null;
  currency: 'ARS' | 'USD' | 'EUR' | null;
  description: string | null;
  supplierName: string | null;
  suggestedCategory: string | null;
  date: string | null;
}

export async function extractTicketFromImage(
  mediaUrl: string,
  contentType?: string,
): Promise<ExtractedTicket | null> {
  const creds = getTwilioCredentials();
  if (!creds) {
    console.error('[WhatsApp] Cannot extract ticket - no Twilio credentials');
    return null;
  }

  const openai = getOpenAIClient();
  if (!openai) {
    console.error('[WhatsApp] Cannot extract ticket - no OpenAI client');
    return null;
  }

  try {
    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
    const imgRes = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
    if (!imgRes.ok) {
      console.error(`[WhatsApp] Ticket download failed: ${imgRes.status}`);
      return null;
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.byteLength < 500) {
      console.error('[WhatsApp] Ticket image too small');
      return null;
    }
    if (buf.byteLength > 20 * 1024 * 1024) {
      console.error('[WhatsApp] Ticket image too large');
      return null;
    }
    const mime = (imgRes.headers.get('content-type') || contentType || 'image/jpeg').split(';')[0].trim();
    const base64 = buf.toString('base64');

    const response = await openai.chat.completions.create({
      model: AI_MODELS.ADVANCED,
      messages: [
        {
          role: 'system',
          content: `Sos un extractor de información de comprobantes (tickets, facturas, recibos) para un usuario argentino. Analizá la imagen y devolvé JSON ESTRICTO con estas claves:
{
  "isReceipt": boolean,
  "type": "expense" | "income",
  "amount": número (el TOTAL del comprobante, sin símbolo de moneda),
  "currency": "ARS" | "USD" | "EUR",
  "description": string corta (ej: "Compra en supermercado", "Almuerzo", "Carga de combustible"),
  "supplierName": string | null (razón social o nombre comercial del emisor),
  "suggestedCategory": string (categoría tentativa: "Supermercado", "Combustible", "Servicios", "Restaurante", "Insumos", etc.),
  "date": string ISO YYYY-MM-DD si la podés leer, si no null
}

REGLAS:
- Si la imagen NO es un comprobante (es una foto cualquiera, una pantalla, un meme), devolvé {"isReceipt": false} y nada más.
- Default currency = "ARS" si no podés leer la moneda.
- "type" casi siempre es "expense" (es un comprobante de gasto). Sólo "income" si claramente es un recibo de cobro emitido por el usuario.
- El "amount" es SIEMPRE el TOTAL final pagado, no items sueltos.
- NO incluyas explicaciones, sólo JSON válido sin markdown.`,
        },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } },
            { type: 'text', text: 'Extraé los datos del comprobante en JSON.' },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 400,
    });

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) return null;
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error('[WhatsApp] Ticket JSON parse error:', err, 'raw:', raw);
      return null;
    }
    if (!parsed || parsed.isReceipt === false) return null;

    // Normalización robusta para formatos AR ("12.345,67"), US ("12,345.67")
    // y entero ("12345"). El último separador encontrado es el decimal.
    const parseLocaleAmount = (input: string): number => {
      const cleaned = input.replace(/[^\d.,-]/g, '');
      const lastComma = cleaned.lastIndexOf(',');
      const lastDot = cleaned.lastIndexOf('.');
      let normalized: string;
      if (lastComma === -1 && lastDot === -1) {
        normalized = cleaned;
      } else if (lastComma !== -1 && lastDot !== -1) {
        // Hay ambos: el que aparece último es el decimal.
        if (lastComma > lastDot) {
          normalized = cleaned.replace(/\./g, '').replace(',', '.');
        } else {
          normalized = cleaned.replace(/,/g, '');
        }
      } else {
        // Hay un único tipo de separador. Si va seguido de exactamente 3 dígitos
        // y no hay más separadores, lo tratamos como miles (formato AR "$4.500"
        // o US "4,500"). Caso contrario, es decimal.
        const sep = lastComma !== -1 ? ',' : '.';
        const count = (cleaned.match(new RegExp('\\' + sep, 'g')) || []).length;
        const tail = cleaned.split(sep).pop() || '';
        if (count >= 2 || tail.length === 3) {
          // Múltiples separadores (ej. "1.234.567") o un único grupo de 3 → miles.
          normalized = cleaned.split(sep).join('');
        } else {
          // Decimal (ej. "12,5" o "99.99").
          normalized = sep === ',' ? cleaned.replace(',', '.') : cleaned;
        }
      }
      return parseFloat(normalized);
    };
    const amount = typeof parsed.amount === 'number' && parsed.amount > 0
      ? parsed.amount
      : (typeof parsed.amount === 'string' ? parseLocaleAmount(parsed.amount) : null);
    if (!amount || !Number.isFinite(amount) || amount <= 0) {
      console.error('[WhatsApp] Ticket extracted but amount invalid:', parsed.amount);
      return null;
    }

    const cur = String(parsed.currency || 'ARS').toUpperCase();
    const currency: 'ARS' | 'USD' | 'EUR' = (cur === 'USD' || cur === 'EUR') ? cur : 'ARS';
    const type: 'income' | 'expense' = parsed.type === 'income' ? 'income' : 'expense';

    return {
      isReceipt: true,
      type,
      amount,
      currency,
      description: typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim() : null,
      supplierName: typeof parsed.supplierName === 'string' && parsed.supplierName.trim() ? parsed.supplierName.trim() : null,
      suggestedCategory: typeof parsed.suggestedCategory === 'string' && parsed.suggestedCategory.trim() ? parsed.suggestedCategory.trim() : null,
      date: typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null,
    };
  } catch (err: any) {
    console.error('[WhatsApp] extractTicketFromImage error:', err?.message || err);
    return null;
  }
}

function getTwilioCredentials(): { accountSid: string; authToken: string } | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  if (!accountSid || !authToken) {
    console.error('[WhatsApp] Twilio credentials not configured');
    return null;
  }
  
  return { accountSid, authToken };
}

// Task #297: cuánto esperar entre re-envíos del indicador "escribiendo...".
// Twilio mantiene el indicador prendido ~25s tras cada POST, así que con
// 20s nos da margen para que nunca se apague entre ticks.
const TYPING_HEARTBEAT_INTERVAL_MS = 20_000;

export interface TypingHeartbeat {
  stop: () => void;
}

// Task #297: contexto async para que `sendWhatsAppMessage` (y cualquier
// helper que termine respondiendo) pueda apagar el heartbeat apenas sale
// el primer mensaje real al usuario, sin tener que pasarle el handle por
// parámetro a cada función del flujo. El `finally` del webhook sigue
// siendo la red de seguridad final.
export const __typingHeartbeatAls = new AsyncLocalStorage<TypingHeartbeat>();

// Task #297: mantiene vivo el indicador "escribiendo..." de WhatsApp
// mientras el handler procesa. Sin esto, en flujos largos (foto de ticket
// con visión IA, transcripción de audio, varias llamadas a OpenAI) el
// indicador se apagaba a los ~25s y el usuario pensaba que el bot se
// había caído. Dispara el primer indicador igual que antes, y vuelve a
// disparar cada `TYPING_HEARTBEAT_INTERVAL_MS` hasta que se llame stop().
// Si no hay messageSid, devuelve un stop no-op.
export function startTypingHeartbeat(messageSid: string | null | undefined): TypingHeartbeat {
  if (!messageSid) return { stop: () => {} };
  // Primer tick inmediato (replica el comportamiento previo al heartbeat).
  // Va en modo silencioso: como re-enviamos cada 20s, cualquier 4xx/5xx
  // de Twilio podría spamear los logs en flujos largos. Los fallos del
  // typing indicator no afectan la experiencia del usuario (la respuesta
  // del bot va por otro endpoint), así que se ignoran sin loguear.
  sendTypingIndicator(messageSid, { silent: true }).catch(() => {});
  let stopped = false;
  const interval = setInterval(() => {
    if (stopped) return;
    sendTypingIndicator(messageSid, { silent: true }).catch(() => {});
  }, TYPING_HEARTBEAT_INTERVAL_MS);
  // No bloqueamos el event loop por este timer si el proceso quiere salir.
  // En Node `setInterval` devuelve un Timeout con `.unref()`; en otros
  // entornos (tests con timers mockeados) puede devolver un number, así
  // que validamos en runtime con un type guard tipado.
  const maybeUnref = interval as unknown as { unref?: () => void };
  if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
    },
  };
}

async function sendTypingIndicator(
  messageSid: string,
  opts: { silent?: boolean } = {},
): Promise<boolean> {
  // Task #297: `silent` se usa desde el heartbeat. Como re-enviamos el
  // indicador cada 20s mientras el handler procesa, cualquier 4xx/5xx
  // (típicamente 429 si Twilio nos limita) podría spamear los logs en
  // flujos largos. El indicador es best-effort y no afecta la respuesta
  // real del bot, así que sus fallos se descartan sin ruido.
  const { silent = false } = opts;
  try {
    const creds = getTwilioCredentials();
    if (!creds) {
      if (!silent) console.log('[WhatsApp] Cannot send typing indicator - no credentials');
      return false;
    }

    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');

    const response = await fetch('https://messaging.twilio.com/v2/Indicators/Typing.json', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        messageId: messageSid,
        channel: 'whatsapp'
      })
    });

    if (response.ok) {
      if (!silent) console.log('[WhatsApp] Typing indicator sent successfully');
      return true;
    } else {
      if (!silent) {
        const error = await response.text();
        console.log('[WhatsApp] Typing indicator failed:', response.status, error);
      }
      return false;
    }
  } catch (error) {
    if (!silent) console.error('[WhatsApp] Error sending typing indicator:', error);
    return false;
  }
}

interface ExtractedSlots {
  type: 'income' | 'expense' | 'receivable' | 'payable' | null;
  amount: number | null;
  currency: 'ARS' | 'USD' | 'EUR' | null;
  currencyExplicit: boolean;
  description: string | null;
  hasInvoice: boolean | null;
  autoConfirm: boolean;
  clientName: string | null;
  supplierName: string | null;
}

async function extractTransactionSlots(message: string): Promise<ExtractedSlots> {
  try {
    const openai = getOpenAIClient();
    if (!openai) {
      return { type: null, amount: null, currency: null, currencyExplicit: false, description: null, hasInvoice: null, autoConfirm: false, clientName: null, supplierName: null };
    }
    
    const response = await openai.chat.completions.create({
      model: AI_MODELS.ADVANCED,
      messages: [
        {
          role: 'system',
          content: `Sos un extractor de información de transacciones financieras para usuarios argentinos. Analizá el mensaje COMPLETO y extraé TODA la información disponible:

1. type: "income" (ingreso/cobro), "expense" (gasto/pago), "receivable" (por cobrar), "payable" (por pagar), o null si no es transacción
2. amount: número (sin símbolo), o null
3. currency: "ARS", "USD", "EUR", o null (default ARS)
4. currencyExplicit: true SOLO si el usuario mencionó claramente la moneda
5. description: descripción breve del movimiento
6. hasInvoice: true si dice "con factura"/"tengo factura", false si dice "sin factura"/"no tengo factura", null si no menciona factura
7. autoConfirm: true si el usuario pide confirmar/registrar directamente ("confirmalo", "registralo", "anotalo", "dale", "listo"), false si no
8. clientName: nombre del cliente si se menciona, o null. Detectar patrones como "del cliente X", "de X", "cliente X", "para X" (en contexto de cobro/ingreso)
9. supplierName: nombre del proveedor si se menciona, o null. Detectar patrones como "al proveedor X", "proveedor X", "de proveedor X", "a X" (en contexto de gasto/pago)

EXPRESIONES COLOQUIALES ARGENTINAS (currencyExplicit: true):
- Dólares: "verdes", "billete verde", "dólares", "dolares", "usd", "u$d", "u$s", "dólar blue", "blue"
- Pesos: "pesos", "mangos", "lucas" (en contexto de pesos), "$", "ars"
- Euros: "euros", "€", "eur"

IMPORTANTE: Si NO hay ningún indicador de moneda en el mensaje, currencyExplicit debe ser FALSE.

FACTURA:
- "sin factura", "no tengo factura", "sin comprobante" → hasInvoice: false
- "con factura", "tengo factura", "facturado" → hasInvoice: true
- Si no menciona nada de factura → hasInvoice: null

CONFIRMACIÓN:
- "confirmalo", "registralo", "anotalo", "dale nomás", "listo" → autoConfirm: true
- Si pide confirmar al final del mensaje o dice que lo registre directamente → autoConfirm: true

CLIENTE/PROVEEDOR:
- En cobros/ingresos: la última palabra/nombre suele ser el cliente. Patrones: "del cliente X", "de X", "cliente X", "para X", "cobré X de Y" (Y=cliente)
- En gastos/pagos: la última palabra/nombre suele ser el proveedor. Patrones: "al proveedor X", "proveedor X", "a X", "le pagué a X", "pagué X a Y" (Y=proveedor)
- "cobré 100 del cliente BSM" → clientName: "BSM"
- "cobré de Juan" → clientName: "Juan"
- "cobré 5millones de glam" → clientName: "glam" (en un cobro, "de X" indica el cliente)
- "cobré 500 de Pepsi" → clientName: "Pepsi"
- "me pagó López" → clientName: "López"
- "pagué al proveedor Ferretería López" → supplierName: "Ferretería López"
- "le pagué a López" → supplierName: "López"
- "le pagué 1millon a bullmetrix" → supplierName: "bullmetrix"
- "gasté 50000 en ferretería López" → supplierName: "ferretería López" (en un gasto, "en X" puede indicar proveedor si es nombre propio)
- NO incluir el nombre del cliente/proveedor en la description si ya lo extraés en clientName/supplierName
- IMPORTANTE: Cuando el mensaje es un cobro/ingreso y termina con "de NOMBRE", NOMBRE es el cliente, NO la descripción

Ejemplos:
- "gasté 5000 en almuerzo" → {"type":"expense","amount":5000,"currency":"ARS","currencyExplicit":false,"description":"almuerzo","hasInvoice":null,"autoConfirm":false,"clientName":null,"supplierName":null}
- "cobré 100 dólares del cliente BSM" → {"type":"income","amount":100,"currency":"USD","currencyExplicit":true,"description":"cobro","hasInvoice":null,"autoConfirm":false,"clientName":"BSM","supplierName":null}
- "cobré 5millones de glam" → {"type":"income","amount":5000000,"currency":"ARS","currencyExplicit":false,"description":"cobro","hasInvoice":null,"autoConfirm":false,"clientName":"glam","supplierName":null}
- "le pagué 1millon a bullmetrix" → {"type":"expense","amount":1000000,"currency":"ARS","currencyExplicit":false,"description":"pago","hasInvoice":null,"autoConfirm":false,"clientName":null,"supplierName":"bullmetrix"}
- "pagué 50000 al proveedor López sin factura" → {"type":"expense","amount":50000,"currency":"ARS","currencyExplicit":false,"description":"pago a proveedor","hasInvoice":false,"autoConfirm":false,"clientName":null,"supplierName":"López"}

Respondé SOLO con JSON válido, sin explicaciones.`
        },
        {
          role: 'user',
          content: message
        }
      ],
      temperature: 0,
      max_tokens: 200,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return { type: null, amount: null, currency: null, currencyExplicit: false, description: null, hasInvoice: null, autoConfirm: false, clientName: null, supplierName: null };
    
    const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      type: parsed.type || null,
      amount: parsed.amount || null,
      currency: parsed.currency || null,
      currencyExplicit: parsed.currencyExplicit === true,
      description: parsed.description || null,
      hasInvoice: parsed.hasInvoice !== undefined ? parsed.hasInvoice : null,
      autoConfirm: parsed.autoConfirm === true,
      clientName: parsed.clientName || null,
      supplierName: parsed.supplierName || null,
    };
  } catch (error) {
    console.error('[WhatsApp] Error extracting slots:', error);
    return { type: null, amount: null, currency: null, currencyExplicit: false, description: null, hasInvoice: null, autoConfirm: false, clientName: null, supplierName: null };
  }
}

async function resolveClientSupplier(
  organizationId: string,
  extractedSlots: ExtractedSlots
): Promise<{ clientId: string | null; clientName: string | null; supplierId: string | null; supplierName: string | null; notFoundMessages: string[] }> {
  let clientId: string | null = null;
  let clientName: string | null = null;
  let supplierId: string | null = null;
  let supplierName: string | null = null;
  const notFoundMessages: string[] = [];

  try {
    if (extractedSlots.clientName) {
      const clients = await storage.getClientsByOrganization(organizationId, true);
      const match = fuzzyMatchEntity(extractedSlots.clientName, clients.map(c => ({ id: c.id, name: c.name })));
      if (match) {
        clientId = match.id;
        clientName = match.name;
        console.log(`[WhatsApp] Client matched: "${extractedSlots.clientName}" → "${match.name}" (${match.id})`);
      } else {
        console.log(`[WhatsApp] No client match found for: "${extractedSlots.clientName}"`);
        notFoundMessages.push(`⚠️ No encontré el cliente "${extractedSlots.clientName}" en tu organización. Lo registro sin vincular.`);
      }
    }

    if (extractedSlots.supplierName) {
      const suppliers = await storage.getSuppliersByOrganization(organizationId, true);
      const match = fuzzyMatchEntity(extractedSlots.supplierName, suppliers.map(s => ({ id: s.id, name: s.name })));
      if (match) {
        supplierId = match.id;
        supplierName = match.name;
        console.log(`[WhatsApp] Supplier matched: "${extractedSlots.supplierName}" → "${match.name}" (${match.id})`);
      } else {
        console.log(`[WhatsApp] No supplier match found for: "${extractedSlots.supplierName}"`);
        notFoundMessages.push(`⚠️ No encontré el proveedor "${extractedSlots.supplierName}" en tu organización. Lo registro sin vincular.`);
      }
    }
  } catch (error) {
    console.error('[WhatsApp] Error resolving client/supplier:', error);
  }

  return { clientId, clientName, supplierId, supplierName, notFoundMessages };
}

function fuzzyMatchEntity(
  query: string,
  entities: Array<{ id: string; name: string }>
): { id: string; name: string } | null {
  if (!query || entities.length === 0) return null;

  const normalizedQuery = query.toLowerCase().trim();

  let bestMatch: { id: string; name: string } | null = null;
  let bestScore = 0;

  for (const entity of entities) {
    const normalizedName = entity.name.toLowerCase().trim();

    if (normalizedName === normalizedQuery) {
      return entity;
    }

    let score = 0;

    if (normalizedName.includes(normalizedQuery)) {
      score = normalizedQuery.length / normalizedName.length;
      score = Math.max(score, 0.6);
    } else if (normalizedQuery.includes(normalizedName)) {
      score = normalizedName.length / normalizedQuery.length;
      score = Math.max(score, 0.5);
    } else {
      const queryWords = normalizedQuery.split(/\s+/);
      const nameWords = normalizedName.split(/\s+/);
      let matches = 0;
      for (const qw of queryWords) {
        for (const nw of nameWords) {
          if (nw.includes(qw) || qw.includes(nw)) {
            matches++;
            break;
          }
        }
      }
      if (matches > 0) {
        score = matches / Math.max(queryWords.length, nameWords.length) * 0.5;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = entity;
    }
  }

  return bestScore >= 0.3 ? bestMatch : null;
}

function buildClientSupplierLine(clientName: string | null, supplierName: string | null): string {
  if (clientName) return `👤 Cliente: ${clientName}\n`;
  if (supplierName) return `🏢 Proveedor: ${supplierName}\n`;
  return '';
}

// Intelligent intent classifier using GPT-4o
interface ClassifiedIntent {
  intent: 'switch_org' | 'list_orgs' | 'transaction' | 'query' | 'cancel' | 'confirm' | 'other';
  targetOrgName?: string;
  confidence: number;
}

async function classifyUserIntent(
  message: string, 
  organizations: Array<{ id: string; name: string }>,
  currentOrgName: string
): Promise<ClassifiedIntent> {
  try {
    const openai = getOpenAIClient();
    if (!openai) {
      return { intent: 'other', confidence: 0 };
    }
    
    const orgNames = organizations.map(o => o.name).join('\n- ');
    
    const response = await openai.chat.completions.create({
      model: AI_MODELS.ADVANCED,
      messages: [
        {
          role: 'system',
          content: `Sos un clasificador de intenciones para un bot de finanzas. El usuario está en la organización "${currentOrgName}".

ORGANIZACIONES DISPONIBLES:
- ${orgNames}

INTENCIONES POSIBLES:
1. "switch_org" - quiere cambiar a otra organización (incluye typos como "cambiar aorganizacion", "cambir org", etc.)
2. "list_orgs" - quiere ver lista de organizaciones ("mis organizaciones", "qué orgs tengo")
3. "transaction" - quiere registrar un movimiento (gasté, cobré, pagué, etc.)
4. "query" - pregunta sobre finanzas (cuánto gasté, saldo, resumen)
5. "cancel" - quiere cancelar la operación actual
6. "confirm" - confirma algo (sí, dale, ok)
7. "other" - otra cosa

REGLAS IMPORTANTES:
- Si el usuario escribe solo un nombre o parte de un nombre que coincide con una organización, asumí que quiere cambiar a esa org
- Tolerá errores de tipeo y ortografía ("enzo rafael" = "Finanzas de ENZO RAFAEL PAREDES")
- Si menciona "cambiar", "usar", "ir a", "pasar a" + algo que parece org → switch_org
- IMPORTANTE: En Argentina, "cuenta" puede referirse a una ORGANIZACIÓN. Si el usuario dice "no, es mi cuenta de X" o "quiero la cuenta X" y X coincide con una organización → switch_org
- Si el usuario menciona un nombre de organización diciendo que quiere usarla o que se equivocó de org → switch_org
- Extraé targetOrgName con el nombre más cercano de la lista (el texto que escribió el usuario, para hacer fuzzy match después)

Respondé SOLO con JSON: {"intent": "...", "targetOrgName": "..." o null, "confidence": 0-100}`
        },
        {
          role: 'user',
          content: message
        }
      ],
      temperature: 0,
      max_tokens: 150,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return { intent: 'other', confidence: 0 };
    
    const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      intent: parsed.intent || 'other',
      targetOrgName: parsed.targetOrgName || undefined,
      confidence: parsed.confidence || 0
    };
  } catch (error) {
    console.error('[WhatsApp] Error classifying intent:', error);
    return { intent: 'other', confidence: 0 };
  }
}

// Fuzzy organization name matching
function findBestOrgMatch(
  searchTerm: string, 
  organizations: Array<{ id: string; name: string }>
): { org: { id: string; name: string }; score: number } | null {
  if (!searchTerm || organizations.length === 0) return null;
  
  const normalizedSearch = searchTerm.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // Remove accents
  
  let bestMatch: { org: { id: string; name: string }; score: number } | null = null;
  
  for (const org of organizations) {
    const normalizedName = org.name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    let score = 0;
    
    // Exact match
    if (normalizedName === normalizedSearch) {
      score = 100;
    }
    // Contains full search term
    else if (normalizedName.includes(normalizedSearch)) {
      score = 80 + (normalizedSearch.length / normalizedName.length) * 15;
    }
    // Search term contains org name
    else if (normalizedSearch.includes(normalizedName)) {
      score = 70;
    }
    // Word-by-word matching
    else {
      const searchWords = normalizedSearch.split(/\s+/).filter(w => w.length > 2);
      const nameWords = normalizedName.split(/\s+/);
      
      let matchedWords = 0;
      for (const searchWord of searchWords) {
        for (const nameWord of nameWords) {
          if (nameWord.includes(searchWord) || searchWord.includes(nameWord)) {
            matchedWords++;
            break;
          }
        }
      }
      
      if (searchWords.length > 0) {
        score = (matchedWords / searchWords.length) * 60;
      }
    }
    
    if (score > 30 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { org, score };
    }
  }
  
  return bestMatch;
}

async function getFinancialContext(userId: string, organizationId: string): Promise<string> {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const monthName = monthNames[now.getMonth()];
    const lastMonthName = monthNames[startOfLastMonth.getMonth()];
    
    // Get accounts with details
    const accounts = await storage.getAccountsByOrganization(organizationId);
    const transactions = await storage.getTransactionsByOrganization(organizationId);
    
    // Sort transactions by date (newest first)
    const sortedTransactions = [...transactions].sort((a, b) => {
      const dateA = new Date(a.createdAt || 0).getTime();
      const dateB = new Date(b.createdAt || 0).getTime();
      return dateB - dateA;
    });
    
    // This month transactions
    const thisMonthTransactions = sortedTransactions.filter(t => new Date(t.createdAt!) >= startOfMonth);
    const thisMonthIncome = thisMonthTransactions.filter(t => t.type === 'income').reduce((sum, t) => sum + Number(t.amount), 0);
    const thisMonthExpense = thisMonthTransactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + Number(t.amount), 0);
    
    // Last month transactions
    const lastMonthTransactions = sortedTransactions.filter(t => {
      const date = new Date(t.createdAt!);
      return date >= startOfLastMonth && date <= endOfLastMonth;
    });
    const lastMonthIncome = lastMonthTransactions.filter(t => t.type === 'income').reduce((sum, t) => sum + Number(t.amount), 0);
    const lastMonthExpense = lastMonthTransactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + Number(t.amount), 0);
    
    // Format accounts list with balances
    const accountsList = accounts.map(a => {
      const symbol = a.currency === 'USD' || a.currency === 'USD_CASH' ? 'U$D' : a.currency === 'EUR' ? '€' : '$';
      const balance = parseFloat(a.balance || '0');
      return `  - ${a.name}: ${symbol}${balance.toLocaleString('es-AR')} (${a.currency || 'ARS'})`;
    }).join('\n');
    
    // Calculate totals by currency
    const totalsByCurrency: Record<string, number> = {};
    for (const account of accounts) {
      const currency = account.currency || 'ARS';
      const balance = parseFloat(account.balance || '0');
      totalsByCurrency[currency] = (totalsByCurrency[currency] || 0) + balance;
    }
    const totalsFormatted = Object.entries(totalsByCurrency).map(([currency, balance]) => {
      const symbol = currency === 'USD' || currency === 'USD_CASH' ? 'U$D' : currency === 'EUR' ? '€' : '$';
      return `${symbol}${balance.toLocaleString('es-AR')} ${currency}`;
    }).join(' | ');
    
    // Top expense categories this month
    const categoryTotals: Record<string, number> = {};
    thisMonthTransactions.filter(t => t.type === 'expense').forEach(t => {
      const cat = t.category || 'Sin categoría';
      categoryTotals[cat] = (categoryTotals[cat] || 0) + Number(t.amount);
    });
    const topCategories = Object.entries(categoryTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat, amount]) => `${cat}: $${amount.toLocaleString('es-AR')}`);
    
    // Financial health indicators
    const totalBalance = accounts.reduce((sum, a) => sum + parseFloat(a.balance || '0'), 0);
    const monthBalance = thisMonthIncome - thisMonthExpense;
    const savingsRate = thisMonthIncome > 0 ? ((thisMonthIncome - thisMonthExpense) / thisMonthIncome * 100).toFixed(1) : '0';
    const incomeGrowth = lastMonthIncome > 0 ? (((thisMonthIncome - lastMonthIncome) / lastMonthIncome) * 100).toFixed(1) : 'N/A';
    const expenseGrowth = lastMonthExpense > 0 ? (((thisMonthExpense - lastMonthExpense) / lastMonthExpense) * 100).toFixed(1) : 'N/A';
    
    // Health assessment
    let healthStatus = 'EXCELENTE';
    let healthEmoji = '🟢';
    if (monthBalance < 0) {
      healthStatus = 'CRÍTICA';
      healthEmoji = '🔴';
    } else if (parseFloat(savingsRate) < 10) {
      healthStatus = 'AJUSTADA';
      healthEmoji = '🟡';
    } else if (parseFloat(savingsRate) < 20) {
      healthStatus = 'BUENA';
      healthEmoji = '🟢';
    }
    
    // Pending receivables and payables
    const receivables = transactions.filter(t => t.type === 'receivable' && t.status !== 'completed');
    const payables = transactions.filter(t => t.type === 'payable' && t.status !== 'completed');
    const totalReceivables = receivables.reduce((sum, t) => sum + Number(t.amount), 0);
    const totalPayables = payables.reduce((sum, t) => sum + Number(t.amount), 0);
    
    // Recent transactions list (last 50 for context, with total count)
    const recentTransactionsLimit = 50;
    const recentTransactions = sortedTransactions.slice(0, recentTransactionsLimit);
    const recentTransactionsList = recentTransactions.map(t => {
      const typeEmoji = t.type === 'income' ? '💵' : t.type === 'expense' ? '💸' : t.type === 'receivable' ? '📥' : '📤';
      const amount = Number(t.amount);
      const date = t.createdAt ? new Date(t.createdAt).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) : '';
      const currency = t.currency || 'ARS';
      const symbol = currency === 'USD' || currency === 'USD_CASH' ? 'U$D' : currency === 'EUR' ? '€' : '$';
      return `  ${typeEmoji} ${date} ${symbol}${amount.toLocaleString('es-AR')} - ${t.description || 'Sin descripción'}`;
    }).join('\n');
    
    // Historical totals
    const totalIncome = transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + Number(t.amount), 0);
    const totalExpense = transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + Number(t.amount), 0);
    
    return `CUENTAS DE LA ORGANIZACIÓN (${accounts.length} cuentas):
${accountsList || '  No hay cuentas'}

SALDOS TOTALES: ${totalsFormatted || '$0'}

=== SALUD FINANCIERA: ${healthEmoji} ${healthStatus} ===
- Tasa de ahorro del mes: ${savingsRate}%
- Variación ingresos vs mes anterior: ${incomeGrowth}%
- Variación gastos vs mes anterior: ${expenseGrowth}%
- Por cobrar pendiente: $${totalReceivables.toLocaleString('es-AR')} (${receivables.length} pendientes)
- Por pagar pendiente: $${totalPayables.toLocaleString('es-AR')} (${payables.length} pendientes)

=== TOTALES HISTÓRICOS (desde el inicio) ===
- Total ingresos históricos: $${totalIncome.toLocaleString('es-AR')}
- Total gastos históricos: $${totalExpense.toLocaleString('es-AR')}
- Balance histórico: $${(totalIncome - totalExpense).toLocaleString('es-AR')}
- Total movimientos registrados: ${transactions.length}

=== RESUMEN DE ${monthName.toUpperCase()} (MES ACTUAL) ===
- Ingresos: $${thisMonthIncome.toLocaleString('es-AR')} (${thisMonthTransactions.filter(t => t.type === 'income').length} movimientos)
- Gastos: $${thisMonthExpense.toLocaleString('es-AR')} (${thisMonthTransactions.filter(t => t.type === 'expense').length} movimientos)
- Balance del mes: $${monthBalance.toLocaleString('es-AR')}
${topCategories.length > 0 ? `- Top gastos: ${topCategories.join(', ')}` : ''}

=== RESUMEN DE ${lastMonthName.toUpperCase()} (MES ANTERIOR) ===
- Ingresos: $${lastMonthIncome.toLocaleString('es-AR')}
- Gastos: $${lastMonthExpense.toLocaleString('es-AR')}
- Balance: $${(lastMonthIncome - lastMonthExpense).toLocaleString('es-AR')}

=== ÚLTIMOS ${recentTransactions.length} MOVIMIENTOS (de ${transactions.length} total) ===
${recentTransactionsList || '  No hay movimientos registrados'}`;
  } catch (error) {
    console.error('[WhatsApp] Error getting financial context:', error);
    return 'No se pudo obtener el contexto financiero.';
  }
}

async function getOrganizationSummary(organizationId: string): Promise<string> {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthName = now.toLocaleDateString('es-AR', { month: 'long' });
    
    const accounts = await storage.getAccountsByOrganization(organizationId);
    const transactions = await storage.getTransactionsByOrganization(organizationId);
    const thisMonthTransactions = transactions.filter(t => new Date(t.createdAt!) >= startOfMonth);
    
    // Calculate totals by currency
    const balancesByCurrency: Record<string, number> = {};
    for (const account of accounts) {
      const currency = account.currency || 'ARS';
      const balance = parseFloat(account.balance || '0');
      balancesByCurrency[currency] = (balancesByCurrency[currency] || 0) + balance;
    }
    
    // Format balances
    const balanceLines = Object.entries(balancesByCurrency).map(([currency, balance]) => {
      const symbol = currency === 'USD' || currency === 'USD_CASH' ? 'U$D' : currency === 'EUR' ? '€' : '$';
      return `${symbol}${balance.toLocaleString('es-AR')} ${currency}`;
    }).join(' | ');
    
    // Month summary
    const incomeTotal = thisMonthTransactions.filter(t => t.type === 'income').reduce((sum, t) => sum + Number(t.amount), 0);
    const expenseTotal = thisMonthTransactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + Number(t.amount), 0);
    const monthBalance = incomeTotal - expenseTotal;
    const balanceIcon = monthBalance >= 0 ? '📈' : '📉';
    
    return `💰 *Saldos*: ${balanceLines || '$0'}
🏦 *Cuentas*: ${accounts.length}
📊 *${monthName}*: ${balanceIcon} $${monthBalance.toLocaleString('es-AR')} (${thisMonthTransactions.length} mov.)`;
  } catch (error) {
    console.error('[WhatsApp] Error getting organization summary:', error);
    return '';
  }
}

interface UserContext {
  name: string;
  preferredName: string | null;
  email: string;
  accountType: string;
}

async function generateAIResponse(
  message: string, 
  financialContext: string, 
  orgName: string, 
  userContext: UserContext,
  isRecentConversation: boolean = false
): Promise<string> {
  try {
    const openai = getOpenAIClient();
    if (!openai) {
      return 'Servicio temporalmente no disponible. Intentá de nuevo más tarde.';
    }
    
    const greeting = getArgentinaGreeting();
    // Safe fallback for user name - handle empty/undefined cases
    const userName = userContext.preferredName || 
      (userContext.name && userContext.name.trim() ? userContext.name.split(' ')[0] : null);
    
    const conversationContext = isRecentConversation 
      ? userName 
        ? `El usuario se llama ${userName}. Te escribió hace poco, NO lo saludes como si fuera la primera vez. Respondé directamente sin saludos.`
        : `El usuario te escribió hace poco, NO lo saludes como si fuera la primera vez. Respondé directamente sin saludos.`
      : userName
        ? `El usuario se llama ${userName}. Si corresponde saludar, usá "${greeting}, ${userName}" en lugar de "Hola". Pero NO saludes si está preguntando algo específico.`
        : `Si corresponde saludar, usá "${greeting}" en lugar de "Hola". Pero NO saludes si el usuario está preguntando algo específico.`;
    
    const response = await openai.chat.completions.create({
      model: AI_MODELS.ADVANCED,
      messages: [
        {
          role: 'system',
          content: `Sos Aike, asistente financiero por WhatsApp para PyMEs argentinas.

USUARIO:
${userContext.name ? `- Nombre: ${userContext.name}` : '- Nombre: no registrado'}
${userName ? `- Llamalo: ${userName} (nombre preferido)` : '- Sin nombre preferido establecido'}
- Email: ${userContext.email || 'no disponible'}
- Tipo de cuenta: ${userContext.accountType === 'personal' ? 'Personal' : 'Empresa'}

ORGANIZACIÓN ACTUAL: ${orgName}

${financialContext}

CONTEXTO DE CONVERSACIÓN:
${conversationContext}

INSTRUCCIONES CRÍTICAS:
1. ${userName ? `Llamá al usuario por su nombre (${userName}) cuando corresponda, especialmente en saludos` : 'Si el usuario te da su nombre, usalo en saludos y conversaciones'}
2. SIEMPRE usá los datos reales que tenés arriba. Tenés los ÚLTIMOS 50 MOVIMIENTOS detallados + TOTALES HISTÓRICOS completos + salud financiera
3. Si preguntan por saldos → usá SALDOS TOTALES y CUENTAS
4. Si preguntan por gastos/ingresos → usá RESUMEN DEL MES y comparación con mes anterior
5. Si preguntan por salud financiera → usá SALUD FINANCIERA con tasa de ahorro, variaciones, pendientes
6. Si preguntan por movimientos/historial → mostrá los últimos 50 movimientos del contexto + mencioná el total histórico
7. Si preguntan análisis → calculá insights: tendencias, categorías más costosas, recomendaciones
8. Podés dar respuestas más largas (hasta 400 palabras) si piden información detallada
9. Usá español argentino casual pero profesional
10. Si el usuario dice "llamame X", respondé que lo vas a recordar

TIPOS DE CONSULTAS QUE PODÉS RESPONDER:
• Resumen: "dame un resumen de mis movimientos" → usá TOTALES HISTÓRICOS y lista de últimos movimientos
• Salud: "cómo está mi salud financiera" → indicadores, tasa ahorro, variaciones, recomendaciones
• Análisis: "en qué gasto más" → top categorías con montos
• Historial: "todos mis movimientos" → mostrá los últimos 50 movimientos que tenés en contexto
• Comparativas: "gasté más o menos que el mes pasado" → comparación con datos reales del mes actual vs anterior

ACCIONES QUE DEBEN HACERSE DESDE LA WEB:
⚠️ Cuando el usuario quiera CREAR o AGREGAR cualquiera de estas cosas, respondé amablemente que lo haga desde la app web porque es más seguro, simple y detallado:
• Cuentas bancarias o de efectivo
• Clientes
• Proveedores
• Productos
• Activos
• Inversiones
• Organizaciones
• Miembros del equipo

Ejemplo de respuesta: "Para crear cuentas te recomiendo hacerlo desde la app web en aikestar.net → es más seguro, más simple y tenés todas las opciones disponibles. Desde acá por WhatsApp podés registrar tus movimientos fácilmente 💰"

FORMATO:
📊 Análisis | 💰 Cuentas | 💸 Gastos | 💵 Ingresos | 📈 Balance | 🟢🟡🔴 Salud`
        },
        { role: 'user', content: message }
      ],
      temperature: 0.7,
      max_tokens: 600,
    });

    return response.choices[0]?.message?.content?.trim() || 'No pude procesar tu mensaje.';
  } catch (error) {
    console.error('[WhatsApp AI] Error:', error);
    return 'Disculpá, tuve un problema. ¿Podés intentar de nuevo?';
  }
}

export async function sendWhatsAppMessage(to: string, message: string): Promise<boolean> {
  try {
    // Task #297: si el handler está corriendo dentro del contexto del
    // heartbeat, apenas el bot manda su primera respuesta real al usuario
    // ya no necesitamos seguir refrescando el "escribiendo...". stop() es
    // idempotente, así que mensajes posteriores son no-op.
    __typingHeartbeatAls.getStore()?.stop();
    console.log('[WhatsApp] Attempting to send message to:', to);
    
    const creds = getTwilioCredentials();
    if (!creds) {
      return false;
    }

    console.log('[WhatsApp] Auth debug - SID length:', creds.accountSid.length, 'Token length:', creds.authToken.length);
    console.log('[WhatsApp] Auth debug - SID first 10:', creds.accountSid.substring(0, 10), '... SID last 4:', creds.accountSid.slice(-4));
    
    const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`;
    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: TWILIO_WHATSAPP_NUMBER,
        To: to,
        Body: message,
      }),
    });

    const responseText = await response.text();
    console.log('[WhatsApp] Twilio response status:', response.status);
    
    if (!response.ok) {
      console.error('[WhatsApp] Twilio error:', responseText);
      return false;
    }

    console.log('[WhatsApp] Message sent successfully to:', to);
    return true;
  } catch (error) {
    console.error('[WhatsApp] Error sending message:', error);
    return false;
  }
}

function normalizePhoneNumber(phone: string): string {
  return phone.replace(/\D/g, '');
}

function sendTwiMLResponse(res: Response): void {
  res.set('Content-Type', 'text/xml');
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

function detectOrgSwitchCommand(message: string): string | null {
  const lowerMessage = message.toLowerCase().trim();
  const patterns = [
    /^cambiar\s+a\s+(.+)$/i,
    /^usar\s+(.+)$/i,
    /^organización\s+(.+)$/i,
    /^org\s+(.+)$/i,
    /^(?:no,?\s*)?(?:es\s+)?mi\s+cuenta\s+(?:de\s+)?(.+)$/i,
    /^(?:no,?\s*)?quiero\s+(?:la\s+)?(?:cuenta|org(?:anizaci[oó]n)?)\s+(?:de\s+)?(.+)$/i,
    /^(?:no,?\s*)?(?:pas[aá](?:me|te)\s+a|cambi[aá](?:me|te)\s+a)\s+(.+)$/i,
  ];
  
  for (const pattern of patterns) {
    const match = lowerMessage.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

function detectGenericOrgSwitchRequest(message: string): boolean {
  const lowerMessage = message.toLowerCase().trim();
  const genericPatterns = [
    /cambiar?\s*(de)?\s*organi[sz]aci[oó]n/i,
    /cambiar?\s*(de)?\s*org/i,
    /cambiar?\s*(de)?\s*empresa/i,
    /cambiar?\s*(de)?\s*cuenta/i,
    /otra\s*organi[sz]aci[oó]n/i,
    /otra\s*org/i,
    /otra\s*empresa/i,
    /otra\s*cuenta/i,
    /quiero\s*(usar|cambiar)\s*(a)?\s*otra/i,
    /cambio\s*(de)?\s*org/i,
    /cambio\s*(de)?\s*empresa/i,
    /cambio\s*(de)?\s*cuenta/i,
    /seleccionar\s*organi[sz]aci[oó]n/i,
    /elegir\s*organi[sz]aci[oó]n/i,
  ];
  
  return genericPatterns.some(pattern => pattern.test(lowerMessage));
}

function isNewQueryMessage(message: string): boolean {
  const lowerMessage = message.toLowerCase().trim();
  // Detect question patterns that indicate a new query, not a response to current step
  const queryPatterns = [
    /^(cu[aá]nto|cuanto)\s/i,           // cuánto gasté, cuánto tengo
    /^(cu[aá]l|cual)\s/i,               // cuál es mi saldo
    /^(qu[eé]|que)\s/i,                 // qué gasté, qué movimientos
    /^(c[oó]mo|como)\s/i,               // cómo cambio de org
    /^(d[oó]nde|donde)\s/i,             // dónde veo mis cuentas
    /^(por qu[eé]|porque)\s/i,          // por qué no funciona
    /^(cu[aá]ndo|cuando)\s/i,           // cuándo fue mi último ingreso
    /\?\s*$/,                           // ends with question mark
    /^(tengo|hay|puedo|pod[eé]s|podr[ií]as)/i,  // tengo saldo, hay movimientos
    /^(mostrame|decime|contame|explicame|dame)/i,    // mostrame los gastos, dame un resumen
    /^(resumen|balance|saldo|salud|analisis|análisis)/i,        // resumen del mes, salud financiera
  ];
  
  return queryPatterns.some(pattern => pattern.test(lowerMessage));
}

function isAllMovementsRequest(message: string): boolean {
  const lowerMessage = message.toLowerCase().trim();
  const allMovementsPatterns = [
    /todos?\s+(mis\s+)?movimientos/i,
    /lista\s+(de\s+)?(todos?\s+)?(mis\s+)?movimientos/i,
    /historial\s+(completo|de\s+movimientos)/i,
    /mostrame\s+todos?\s+(los\s+)?movimientos/i,
    /dame\s+todos?\s+(los\s+)?movimientos/i,
    /quiero\s+ver\s+todos?\s+(los\s+)?movimientos/i,
    /todos?\s+los\s+gastos\s+e?\s*ingresos/i,
    /lista\s+completa/i,
  ];
  
  return allMovementsPatterns.some(pattern => pattern.test(lowerMessage));
}

async function sendAllMovementsInChunks(phoneNumber: string, transactions: any[], orgName: string): Promise<void> {
  if (transactions.length === 0) {
    await sendWhatsAppMessage(phoneNumber, `📍 *${orgName}*\n\n📋 No tenés movimientos registrados todavía.`);
    return;
  }
  
  const sortedTransactions = [...transactions].sort((a, b) => {
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return dateB - dateA;
  });
  
  const header = `📍 *${orgName}*\n\n📋 *Todos tus movimientos (${sortedTransactions.length} total):*\n\n`;
  await sendWhatsAppMessage(phoneNumber, header);
  
  let currentChunk = '';
  const maxChunkLength = 1400;
  
  for (let i = 0; i < sortedTransactions.length; i++) {
    const t = sortedTransactions[i];
    const typeEmoji = t.type === 'income' ? '💵' : t.type === 'expense' ? '💸' : t.type === 'receivable' ? '📥' : '📤';
    const amount = Number(t.amount);
    const date = t.createdAt ? new Date(t.createdAt).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : 'S/F';
    const currency = t.currency || 'ARS';
    const symbol = currency === 'USD' || currency === 'USD_CASH' ? 'U$D' : currency === 'EUR' ? '€' : '$';
    const line = `${typeEmoji} ${date} ${symbol}${amount.toLocaleString('es-AR')} - ${t.description || 'Sin descripción'}\n`;
    
    if ((currentChunk + line).length > maxChunkLength) {
      await sendWhatsAppMessage(phoneNumber, currentChunk.trim());
      await new Promise(resolve => setTimeout(resolve, 500));
      currentChunk = line;
    } else {
      currentChunk += line;
    }
  }
  
  if (currentChunk.trim()) {
    await sendWhatsAppMessage(phoneNumber, currentChunk.trim());
  }
  
  // Calculate totals by currency
  const currencies = Array.from(new Set(sortedTransactions.map(t => t.currency || 'ARS')));
  const summaryLines: string[] = ['📊 *Resumen por moneda:*'];
  
  for (const currency of currencies) {
    const currencyTxs = sortedTransactions.filter(t => (t.currency || 'ARS') === currency);
    const income = currencyTxs.filter(t => t.type === 'income').reduce((sum, t) => sum + Number(t.amount), 0);
    const expense = currencyTxs.filter(t => t.type === 'expense').reduce((sum, t) => sum + Number(t.amount), 0);
    const balance = income - expense;
    const symbol = currency === 'USD' || currency === 'USD_CASH' ? 'U$D' : currency === 'EUR' ? '€' : '$';
    const currencyLabel = currency === 'USD' || currency === 'USD_CASH' ? 'Dólares' : currency === 'EUR' ? 'Euros' : 'Pesos';
    
    summaryLines.push(`\n*${currencyLabel}:*`);
    summaryLines.push(`💵 Ingresos: ${symbol}${income.toLocaleString('es-AR')}`);
    summaryLines.push(`💸 Gastos: ${symbol}${expense.toLocaleString('es-AR')}`);
    summaryLines.push(`📈 Balance: ${symbol}${balance.toLocaleString('es-AR')}`);
  }
  
  await new Promise(resolve => setTimeout(resolve, 500));
  await sendWhatsAppMessage(phoneNumber, summaryLines.join('\n'));
}

// Detect when user wants to edit/change something in the current transaction
export function detectEditIntent(message: string): { field: 'account' | 'amount' | 'type' | 'description' | 'currency' | 'category' | 'cancel' | null; value?: string } {
  const lowerMsg = message.toLowerCase().trim();
  
  // Cancel/restart patterns
  if (/^(cancelar|cancel|reiniciar|empezar de nuevo|olvidalo|olvídalo|dejalo|déjalo)/.test(lowerMsg)) {
    return { field: 'cancel' };
  }
  
  // Currency correction patterns - detect "son dólares", "en dólares no pesos", "es en USD", etc.
  const currencyCorrectionPatterns = [
    /(?:son|es|era|eran|fueron|fue)\s+(?:en\s+)?(?:d[oó]lar(?:es)?|usd|u\$[ds]|verde[s]?|blue)/i,
    /(?:en\s+)?(?:d[oó]lar(?:es)?|usd|u\$[ds]|verde[s]?|blue)\s*[,.]?\s*(?:no|y no)\s+(?:en\s+)?(?:peso[s]?|ars)/i,
    /(?:no|ni)\s+(?:en\s+)?(?:peso[s]?|ars)\s*[,.]?\s*(?:en\s+|son\s+)?(?:d[oó]lar(?:es)?|usd|u\$[ds]|verde[s]?|blue)/i,
    /(?:son|es|era|eran|fueron|fue)\s+(?:en\s+)?(?:peso[s]?|ars)/i,
    /(?:en\s+)?(?:peso[s]?|ars)\s*[,.]?\s*(?:no|y no)\s+(?:en\s+)?(?:d[oó]lar(?:es)?|usd|u\$[ds]|verde[s]?|blue)/i,
    /^(?:d[oó]lar(?:es)?|usd|u\$[ds]|verde[s]?|blue)\s*$/i,
    /^(?:peso[s]?|ars)\s*$/i,
    /^(?:en\s+)?(?:d[oó]lar(?:es)?|usd|u\$[ds]|verde[s]?|blue)$/i,
    /^(?:en\s+)?(?:peso[s]?|ars)$/i,
    /(?:cambiar?|cambia)\s+(?:a\s+)?(?:la\s+)?moneda/i,
    /(?:cambiar?|cambia)\s+a\s+(?:d[oó]lar(?:es)?|usd|peso[s]?|ars)/i,
  ];
  
  for (const pattern of currencyCorrectionPatterns) {
    if (pattern.test(lowerMsg)) {
      const isUSD = /d[oó]lar|usd|u\$[ds]|verde|blue/i.test(lowerMsg);
      const isARS = /peso|ars/i.test(lowerMsg);
      if (isUSD && !isARS) {
        return { field: 'currency', value: 'USD' };
      }
      if (isARS && !isUSD) {
        return { field: 'currency', value: 'ARS' };
      }
      if (isUSD && isARS) {
        const usdPos = lowerMsg.search(/d[oó]lar|usd|u\$[ds]|verde|blue/i);
        const arsPos = lowerMsg.search(/peso|ars/i);
        const hasNegation = /no\s+(?:en\s+)?(?:peso|ars|d[oó]lar|usd)/i.test(lowerMsg);
        if (hasNegation) {
          const noPos = lowerMsg.search(/\bno\b/i);
          return { field: 'currency', value: noPos < arsPos ? 'USD' : 'ARS' };
        }
        return { field: 'currency', value: usdPos > arsPos ? 'USD' : 'ARS' };
      }
      return { field: 'currency' };
    }
  }
  
  // Change amount patterns - check BEFORE account to avoid misclassification
  if (/^(cambiar|cambia|modificar|modifica|poner|poné)\s+(el\s+)?(monto|importe|valor)/i.test(lowerMsg)) {
    return { field: 'amount' };
  }
  
  // Change type patterns - check BEFORE account
  if (/^(cambiar|cambia)\s+(a\s+)?(ingreso|gasto|por cobrar|por pagar)/i.test(lowerMsg)) {
    return { field: 'type' };
  }

  // Task #379: Change category patterns (keyword "categoría" present).
  // Va ANTES de cuenta porque "cambiar la categoría a X" podría confundirse
  // con el patrón de cuenta "cambiar a X".
  if (/categor[ií]a/i.test(lowerMsg)) {
    const m = lowerMsg.match(
      /categor[ií]a\s*(?:es|sea|seria|sería|deber[ií]a\s+ser|correcta\s+es|a|por|en|como|:)?\s*(.+)$/i,
    );
    let value = m && m[1] ? m[1].trim() : undefined;
    if (value) {
      value = value.replace(/^(?:la|el|de|en|a|categor[ií]a)\s+/i, '').trim();
      if (value.length < 2 || /^categor[ií]a$/i.test(value)) value = undefined;
    }
    return { field: 'category', value };
  }

  // Change account patterns: requires "cuenta" or "banco" keyword or explicit account reference
  const accountPatterns = [
    /^cambi(a|ar|o)\s+(de\s+)?cuenta/i,                    // cambiar cuenta, cambiar de cuenta
    /^cambi(a|ar|o)\s+(de\s+)?banco/i,                     // cambiar banco, cambiar de banco
    /^cambi(a|ar|o)\s+a\s+(la\s+)?(cuenta\s+)?(.+)/i,      // cambiar a cuenta X, cambiar a personal
    /^(otra|otro)\s+(cuenta|banco)/i,                       // otra cuenta, otro banco
    /(usar|poner)\s+(la\s+)?(otra\s+)?(cuenta|banco)/i,    // usar otra cuenta, poner cuenta, ponerlo a otra cuenta
    /^(en|a)\s+(otra|otro)\s+(cuenta|banco)/i,              // en otra cuenta, a otro banco
    /ponerlo?\s+(?:en|a)\s+(?:otra|otro)\s+(?:cuenta|banco)/i, // ponerlo a otra cuenta, ponerlo en otro banco
    /^cuenta\s+(.+)/i,                                      // cuenta personal
    /(?:ten[eé]s|hay|que)\s+otr[oa]\s+(?:cuenta|banco)/i,  // tenes otra cuenta?, hay otro banco?
    /(?:que|qué)\s+(?:otra|otro)\s+(?:cuenta|banco)/i,     // que otra cuenta?, qué otro banco?
    /(?:que|qué)\s+cuentas?\s+(?:tiene|hay|tenes)/i,       // que cuentas tiene?, que cuenta hay?
  ];
  
  for (const pattern of accountPatterns) {
    const match = lowerMsg.match(pattern);
    if (match) {
      const accountName = match[match.length - 1]?.trim();
      if (accountName && accountName.length > 2 && !['cuenta', 'la', 'de', 'a'].includes(accountName)) {
        return { field: 'account', value: accountName };
      }
      return { field: 'account' };
    }
  }

  // Task #379: Change category by classifying verbs (ej: "ponelo en transporte",
  // "metelo en comida", "clasificalo como combustible"). Va DESPUÉS de cuenta
  // para no pisar frases de cuenta.
  const catVerbMatch = lowerMsg.match(
    /^(?:ponelo?|pon[eé]|metelo?|met[eé]|cargalo?|clasific[aá]lo?|clasific[aá])\s+(?:en|como)\s+(.+)$/i,
  );
  if (catVerbMatch && catVerbMatch[1]) {
    const value = catVerbMatch[1].trim().replace(/^(?:la|el|de)\s+/i, '').trim();
    if (value.length >= 2) {
      return { field: 'category', value };
    }
  }

  // Task #379: Change category by "es/era/va para X" / "es en X". Es ambiguo, así
  // que va DESPUÉS de cuenta y de los verbos fuertes, y se excluye cuando el
  // valor se refiere a un cliente/proveedor/cuenta/banco (esas frases no son
  // categoría) para no desviar mensajes que apuntan a otra cosa.
  const catAmbiguousMatch = lowerMsg.match(
    /^(?:es|era|son|eran|fue|fueron|va|van)\s+(?:para|en)\s+(.+)$/i,
  );
  if (catAmbiguousMatch && catAmbiguousMatch[1]) {
    const value = catAmbiguousMatch[1]
      .trim()
      .replace(/^(?:la|el|los|las|un|una|mi|el\/la)\s+/i, '')
      .trim();
    const refersToOther = /^(?:cliente|clienta|proveedor|proveedora|cuenta|banco|caja|tarjeta)\b/i.test(value);
    if (!refersToOther && value.length >= 2) {
      return { field: 'category', value };
    }
  }

  return { field: null };
}

function parseAccountChoice(message: string, accounts: Array<{ id: string; name: string }>): { id: string; name: string } | null {
  const lowerMsg = message.toLowerCase().trim();
  
  // Check for numeric selection (1, 2, 3)
  const numMatch = lowerMsg.match(/^(\d+)$/);
  if (numMatch) {
    const index = parseInt(numMatch[1], 10) - 1;
    if (index >= 0 && index < accounts.length) {
      return accounts[index];
    }
  }
  
  // Check for account name match
  for (const account of accounts) {
    if (lowerMsg.includes(account.name.toLowerCase()) || 
        account.name.toLowerCase().includes(lowerMsg)) {
      return account;
    }
  }
  
  return null;
}

export function registerWhatsAppRoutes(app: Express) {
  app.post('/api/whatsapp/webhook', async (req: Request, res: Response) => {
    const startTime = Date.now();
    console.log('[WhatsApp Webhook] ========== INCOMING REQUEST ==========');
    console.log('[WhatsApp Webhook] Timestamp:', new Date().toISOString());
    console.log('[WhatsApp Webhook] Body:', JSON.stringify(req.body));
    
    // Immediately acknowledge Twilio to prevent timeout retries
    // Twilio has a 15-second timeout - we respond immediately and process async
    sendTwiMLResponse(res);

    // Task #297: heartbeat del "escribiendo...". Lo arrancamos apenas
    // sabemos el MessageSid y lo apagamos en el finally del handler para
    // garantizar que nunca queda un timer colgado, incluso si hay early
    // return o error.
    let __typingHeartbeat: TypingHeartbeat = { stop: () => {} };

    try {
      const { From, Body, MediaUrl0, MediaContentType0, MessageSid } = req.body;
      
      // Check if this is an audio message
      const isAudioMessage = MediaContentType0?.startsWith('audio/');
      
      // Allow messages with text, image, or audio
      if (!From || (!Body && !MediaUrl0)) {
        console.log('[WhatsApp] Invalid request - missing From or empty message:', req.body);
        return;
      }

      // Task #297: arranca el heartbeat del indicador "escribiendo...".
      // El primer tick se manda de inmediato (idéntico al comportamiento
      // previo) y después se re-envía cada ~20s hasta que termine el
      // handler. Esto evita que el indicador se apague a los ~25s en
      // flujos largos (foto de ticket + visión IA, audio, etc.).
      __typingHeartbeat = startTypingHeartbeat(MessageSid);
      // Task #297: publicamos el heartbeat en el AsyncLocalStorage del
      // request para que `sendWhatsAppMessage` pueda apagarlo apenas el
      // bot mande su primera respuesta real. `enterWith()` es seguro
      // acá porque cada request de Express corre en su propio async
      // context y el `finally` externo garantiza el stop final.
      __typingHeartbeatAls.enterWith(__typingHeartbeat);

      const whatsappNumber = From.replace('whatsapp:', '');
      const normalizedNumber = normalizePhoneNumber(whatsappNumber);
      let message = (Body || '').trim(); // Body can be empty for image-only or audio messages
      
      // If audio message, transcribe it
      if (isAudioMessage && MediaUrl0) {
        console.log(`[WhatsApp] Audio message detected (${MediaContentType0}), transcribing...`);
        const transcription = await transcribeAudio(MediaUrl0, MediaContentType0);
        if (transcription) {
          message = transcription;
          console.log(`[WhatsApp] Audio transcribed to: "${message}"`);
        } else {
          // If transcription fails, send error message to user
          const user = await storage.getUserByPhone(normalizePhoneNumber(whatsappNumber));
          if (user) {
            await sendWhatsAppMessage(From, 
              `⚠️ No pude escuchar bien el audio. ¿Podrías escribirme el mensaje o enviar otro audio más claro?`
            );
          }
          return;
        }
      }
      
      console.log(`[WhatsApp] Message from ${whatsappNumber} (normalized: ${normalizedNumber}): ${message}`);
      console.log(`[WhatsApp] MessageSid: ${MessageSid || 'not provided'}`);
      console.log(`[WhatsApp] Processing time so far: ${Date.now() - startTime}ms`);

      const user = await storage.getUserByPhone(normalizedNumber);
      console.log(`[WhatsApp] User lookup result:`, user ? `Found user ${user.id} (${user.email})` : 'NOT FOUND');

      if (user && user.phoneNumber) {
        const canonical = normalizePhoneInput(whatsappNumber);
        if (canonical.ok && user.phoneNumber !== canonical.phone) {
          try {
            await storage.updateUser(user.id, { phoneNumber: canonical.phone });
            console.log(`[WhatsApp] Lazy-migrated phone for user ${user.id}: ${user.phoneNumber} -> ${canonical.phone}`);
          } catch (err) {
            console.error('[WhatsApp] Failed to lazy-migrate phone:', err);
          }
        }
      }
      
      // Task #212 — Anti-enumeration: we send the EXACT same reply for both
      // "this number is not bound to any account" and "the bound account has
      // not verified its number". An attacker cannot use the bot to probe
      // whether a phone is registered, because the response is indistinguishable.
      // Internal logs differentiate the two so support can still triage.
      const NEEDS_VERIFICATION_REPLY =
        `👋 ¡Hola! Para usar Aike por WhatsApp desde este número, vinculalo y verificalo.\n\n` +
        `1. Ingresá a aikestar.net\n` +
        `2. Andá a Configuración → WhatsApp\n` +
        `3. Cargá tu número y completá la verificación con el código que te enviamos.\n\n` +
        `Una vez verificado, vas a poder registrar movimientos y consultar tus finanzas por acá.`;

      if (!user) {
        console.log(`[WhatsApp] No user bound to ${normalizedNumber} — sending generic verify reply.`);
        const sent = await sendWhatsAppMessage(From, NEEDS_VERIFICATION_REPLY);
        console.log(`[WhatsApp] Message sent result:`, sent);
        return;
      }

      if (user.phoneVerified !== true) {
        console.log(`[WhatsApp] User ${user.id} has unverified phone — sending generic verify reply.`);
        await sendWhatsAppMessage(From, NEEDS_VERIFICATION_REPLY);
        return;
      }

      const organizations = await storage.getOrganizationsByUser(user.id);
      if (!organizations.length) {
        await sendWhatsAppMessage(From, 
          `⚠️ Tu cuenta no tiene organizaciones. Ingresá a aikestar.net para crear una.`
        );
        return;
      }

      // Resolver la org del bot UNA SOLA VEZ con esta prioridad:
      //   (1) Conversación activa (multi-step en curso, no expirada por TTL).
      //       Si el usuario está en medio de un flujo en una org distinta a la
      //       default, ese flujo gana — no podemos saltar de org a la mitad.
      //   (2) Default elegida por el usuario / fallback histórico / primera org.
      //       Esto es lo que hace `resolveWhatsappOrgId`.
      // Si después en este mismo mensaje el usuario menciona explícitamente
      // otra org (org switch), mutamos esta variable LOCAL pero NO persistimos
      // nada en DB: ni `whatsappDefaultOrganizationId` ni `lastActiveOrganizationId`.
      const activeConvOrgId = await findActiveConversationOrgId(user.id);
      const activeConvOrgIsValid =
        !!activeConvOrgId && organizations.some((o) => o.id === activeConvOrgId);
      let effectiveOrgId: string = activeConvOrgIsValid
        ? activeConvOrgId!
        : resolveWhatsappOrgId(user, organizations);

      // Get current organization for welcome/greeting
      const welcomeOrg = organizations.find(o => o.id === effectiveOrgId) || organizations[0];
      const displayName = user.preferredName || user.name;

      // --- Task #284: Lock por (org, user) ---
      // Serializa el procesamiento de mensajes simultáneos del mismo usuario
      // para evitar que dos webhooks concurrentes pisen slots de la
      // conversación (last-write-wins). Si no obtenemos el lock tras los
      // reintentos, contestamos suave pidiendo reintentar y salimos.
      // Implementación: ver `acquireWhatsappLock` en conversation-state.ts.
      const __whatsappLock: WhatsappLockHandle | null = await acquireWhatsappLock(
        user.id,
        effectiveOrgId,
      ).catch((err) => {
        console.error('[WhatsApp] acquireWhatsappLock threw:', err);
        return null;
      });
      if (!__whatsappLock) {
        console.warn(
          `[WhatsApp] Could not acquire conversation lock for user=${user.id} org=${effectiveOrgId}; deferring message.`,
        );
        try {
          await sendWhatsAppMessage(
            From,
            '⏳ Todavía estoy procesando tu mensaje anterior. Mandámelo de nuevo en unos segundos, por favor.',
          );
        } catch (err) {
          console.error('[WhatsApp] Failed to send busy reply:', err);
        }
        return;
      }
      try {

      // --- FIRST-TIME WELCOME MESSAGE ---
      if (!user.whatsappWelcomed) {
        console.log(`[WhatsApp] First-time user ${user.id}, sending welcome message`);
        await sendWhatsAppMessage(From, getWelcomeMessage(displayName, welcomeOrg.name));
        // El welcome ya nombra la org → marcamos al usuario como visto para
        // que el próximo mensaje no vuelva a disparar el banner de Task #209.
        // Lo combinamos con `whatsappWelcomed` en un solo UPDATE para no
        // pegarle dos veces a la DB.
        try {
          await storage.updateUser(user.id, {
            whatsappWelcomed: true,
            lastWhatsappMessageAt: new Date(),
          });
        } catch (err) {
          console.error('[WhatsApp] Failed to persist welcomed/lastWhatsappMessageAt:', err);
        }
        return;
      }

      // --- "¿QUÉ ORG ESTOY USANDO?" — consulta directa, no cambia nada ---
      // Se chequea antes de la lógica de cambio de org para evitar que
      // "qué org" sea capturado por la detección genérica/AI.
      if (detectShowCurrentOrgRequest(message)) {
        await sendWhatsAppMessage(
          From,
          `📍 Estás registrando movimientos en *${welcomeOrg.name}*.\n` +
          `Mandá _"cambiar org"_ para elegir otra o _"mis organizaciones"_ para ver todas.`
        );
        await markUserSeen(user.id);
        return;
      }

      // --- BANNER DE ORG ACTIVA AL INICIO DE LA CONVERSACIÓN (Task #209) ---
      // Mostramos un recordatorio sutil de la org activa cuando arranca una
      // nueva sesión (sin actividad por más de SESSION_GAP_MS) para que el
      // usuario sepa en qué org se va a registrar este mensaje. Lo enviamos
      // como mensaje aparte ANTES del procesamiento normal.
      // No mostramos si:
      //  - El usuario está pidiendo explícitamente cambiar/listar orgs
      //    (la respuesta de cambio ya da contexto y duplicarlo confunde).
      //  - Hay una conversación multi-step activa (no es "nueva sesión").
      const isOrgChangeIntent =
        !!detectOrgSwitchCommand(message) || detectGenericOrgSwitchRequest(message);
      const lowerMessageForBanner = message.toLowerCase();
      const isOrgListIntent =
        lowerMessageForBanner.includes('mis organizaciones') ||
        lowerMessageForBanner.includes('mis orgs');
      const hasActiveConv = !!await findActiveConversationOrgId(user.id);
      // Task #210 — el intervalo del banner es configurable por org desde
      // las preferencias de WhatsApp del usuario. Si no hay preferencia, se
      // usa el default (6 h). Si la preferencia es 0, no se muestra nunca.
      // Si la query falla, logueamos y caemos al default — la UX del banner
      // no debe romper el procesamiento del mensaje.
      const bannerPrefs = await storage
        .getWhatsappPreferences(user.id, welcomeOrg.id)
        .catch((err) => {
          console.error(
            `[WhatsApp] getWhatsappPreferences failed for user=${user.id} org=${welcomeOrg.id}; using default banner interval`,
            err,
          );
          return undefined;
        });
      const bannerGapMs = resolveOrgBannerGapMs(bannerPrefs?.orgBannerIntervalHours);
      if (
        // Task #210 + #211: gap configurable por org y lastSeen persistido.
        shouldShowOrgBanner(user.lastWhatsappMessageAt, Date.now(), bannerGapMs) &&
        !isOrgChangeIntent &&
        !isOrgListIntent &&
        !hasActiveConv
      ) {
        await sendWhatsAppMessage(From, buildOrgBannerMessage(welcomeOrg.name));
      }
      // Marcamos como visto SIEMPRE al recibir un mensaje (incluso si no
      // mandamos banner) para que el próximo mensaje no lo vuelva a tirar.
      // Persistimos en DB (Task #211) para que sobreviva reinicios del server.
      await markUserSeen(user.id);

      // --- NAME PREFERENCE DETECTION (runs early to work in any context) ---
      const namePreferencePatterns = [
        /^llam[aá]me\s+(.+)$/i,
        /^decime\s+(.+)$/i,
        /^prefiero\s+que\s+me\s+(llames|digas)\s+(.+)$/i,
        /^quiero\s+que\s+me\s+(llames|digas)\s+(.+)$/i,
        /^mi\s+nombre\s+(es|sera?)\s+(.+)$/i,
      ];
      
      for (const pattern of namePreferencePatterns) {
        const match = message.match(pattern);
        if (match) {
          const newPreferredName = match[match.length - 1].trim();
          if (newPreferredName && newPreferredName.length >= 2 && newPreferredName.length <= 30) {
            await storage.updateUser(user.id, { preferredName: newPreferredName });
            await sendWhatsAppMessage(From, 
              `¡Perfecto, ${newPreferredName}! 😊 De ahora en adelante te voy a llamar así.\n\n¿En qué te puedo ayudar?`
            );
            return;
          }
        }
      }

      // --- INTELLIGENT ORG SWITCHING ---
      // First try exact pattern matching for quick responses
      const orgSwitchTarget = detectOrgSwitchCommand(message);
      if (orgSwitchTarget) {
        // Try fuzzy matching first
        const orgsList = organizations.map(o => ({ id: o.id, name: o.name }));
        const match = findBestOrgMatch(orgSwitchTarget, orgsList);
        
        if (match && match.score > 40) {
          // Cambio LOCAL a la conversación; no persistimos en DB.
          effectiveOrgId = match.org.id;
          // Task #207: registrar la conversación en la nueva org para que
          // findActiveConversationOrgId() devuelva esta org en el próximo
          // mensaje y el bot no vuelva a la default del usuario.
          await getOrCreateConversation(user.id, match.org.id);
          const summary = await getOrganizationSummary(match.org.id);
          await sendWhatsAppMessage(From, 
            `✅ ¡Cambiado a *${match.org.name}*!\n\n` +
            `${summary}\n\n` +
            `¿Qué querés hacer?`
          );
        } else {
          const currentOrgId = effectiveOrgId;
          const orgList = organizations.map(o => {
            const isCurrent = o.id === currentOrgId;
            return `${isCurrent ? '👉 ' : '• '}${o.name}${isCurrent ? ' (actual)' : ''}`;
          }).join('\n');
          await sendWhatsAppMessage(From, 
            `No encontré esa organización 🤔\n\nTus organizaciones son:\n${orgList}\n\n` +
            `Escribí el nombre o parte del nombre`
          );
        }
        return;
      }

      // Check for "mis organizaciones" command
      if (message.toLowerCase().includes('mis organizaciones') || message.toLowerCase().includes('mis orgs')) {
        const currentOrgId = effectiveOrgId;
        const orgList = organizations.map(o => {
          const isCurrent = o.id === currentOrgId;
          return `${isCurrent ? '👉 ' : '• '}${o.name}${isCurrent ? ' _(actual)_' : ''}`;
        }).join('\n');
        await sendWhatsAppMessage(From, 
          `📋 *Tus organizaciones:*\n\n${orgList}\n\n` +
          `Escribí el nombre para cambiar`
        );
        return;
      }

      // Check for generic "cambiar organización" requests (without specific name)
      // BUT skip if user is in confirm/account step — "cuenta" means financial account there
      const activeConv = await peekConversation(user.id, effectiveOrgId);
      const isInAccountContext = activeConv && 
        (activeConv.currentStep === 'confirm' || activeConv.currentStep === 'account') &&
        (activeConv.slots.type !== null || activeConv.slots.amount !== null);
      const isInActiveWizardStep = activeConv && 
        activeConv.currentStep !== 'type' &&
        (activeConv.slots.type !== null || activeConv.slots.amount !== null);
      
      if (detectGenericOrgSwitchRequest(message) && !isInAccountContext) {
        const currentOrgId = effectiveOrgId;
        const orgList = organizations.map(o => {
          const isCurrent = o.id === currentOrgId;
          return `${isCurrent ? '👉 ' : '• '}${o.name}${isCurrent ? ' _(actual)_' : ''}`;
        }).join('\n');
        await sendWhatsAppMessage(From, 
          `📋 *¿A qué organización querés cambiar?*\n\n${orgList}\n\n` +
          `Escribí el nombre o parte del nombre`
        );
        return;
      }
      
      // --- INTELLIGENT INTENT CLASSIFICATION (fallback for ambiguous messages) ---
      // Use AI classification for messages that might be org-related OR short ambiguous messages
      const lowerMessage = message.toLowerCase().trim();
      const messageWords = lowerMessage.split(/\s+/);
      const isShortMessage = messageWords.length <= 4 && lowerMessage.length < 40;
      const hasOrgKeywords = lowerMessage.includes('cambiar') || lowerMessage.includes('organiz') || 
         lowerMessage.includes('org') || lowerMessage.includes('empresa') ||
         lowerMessage.includes('usar') || lowerMessage.includes('pasar') ||
         lowerMessage.includes('mi cuenta de') || lowerMessage.includes('es mi cuenta');
      const containsOrgName = organizations.some(o => {
        const orgWords = o.name.toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .split(/\s+/).filter(w => w.length > 2);
        const normalizedMsg = lowerMessage.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return orgWords.some(word => normalizedMsg.includes(word));
      });
      
      // Broaden: also trigger for short messages that look like names (not common commands)
      const looksLikeName = isShortMessage && !lowerMessage.match(/^\d+$/) && 
        !['si', 'sí', 'no', 'ok', 'dale', 'listo', 'cancelar', 'hola'].includes(lowerMessage);
      
      const mightBeOrgRelated = lowerMessage.length < 100 && !lowerMessage.match(/^\d+$/) && 
        (hasOrgKeywords || containsOrgName || looksLikeName);
      
      if (mightBeOrgRelated && !isInActiveWizardStep) {
        const currentOrgId = effectiveOrgId;
        const currentOrg = organizations.find(o => o.id === currentOrgId) || organizations[0];
        const orgsList = organizations.map(o => ({ id: o.id, name: o.name }));
        
        // Use AI to classify intent
        const classifiedIntent = await classifyUserIntent(message, orgsList, currentOrg.name);
        console.log('[WhatsApp] Classified intent:', classifiedIntent);
        
        if (classifiedIntent.intent === 'switch_org' && classifiedIntent.confidence >= 60) {
          if (classifiedIntent.targetOrgName) {
            // Try fuzzy match with the extracted org name
            const match = findBestOrgMatch(classifiedIntent.targetOrgName, orgsList);
            if (match && match.score > 30) {
              // Cambio LOCAL a la conversación; no persistimos en DB.
              effectiveOrgId = match.org.id;
              // Task #207: registrar la conversación en la nueva org para que
              // findActiveConversationOrgId() devuelva esta org en el próximo
              // mensaje y el bot no vuelva a la default del usuario.
              await getOrCreateConversation(user.id, match.org.id);
              const summary = await getOrganizationSummary(match.org.id);
              await sendWhatsAppMessage(From, 
                `✅ ¡Cambiado a *${match.org.name}*!\n\n` +
                `${summary}\n\n` +
                `¿Qué querés hacer?`
              );
              return;
            }
          }
          // No specific org found, show list
          const orgList = organizations.map(o => {
            const isCurrent = o.id === currentOrgId;
            return `${isCurrent ? '👉 ' : '• '}${o.name}${isCurrent ? ' _(actual)_' : ''}`;
          }).join('\n');
          await sendWhatsAppMessage(From, 
            `📋 *¿A qué organización querés cambiar?*\n\n${orgList}\n\n` +
            `Escribí el nombre o parte del nombre`
          );
          return;
        }
        
        if (classifiedIntent.intent === 'list_orgs') {
          const orgList = organizations.map(o => {
            const isCurrent = o.id === currentOrgId;
            return `${isCurrent ? '👉 ' : '• '}${o.name}${isCurrent ? ' _(actual)_' : ''}`;
          }).join('\n');
          await sendWhatsAppMessage(From, 
            `📋 *Tus organizaciones:*\n\n${orgList}\n\n` +
            `Escribí el nombre para cambiar`
          );
          return;
        }
        
        // Handle "todos mis movimientos" request - send ALL transactions in chunks
        if (isAllMovementsRequest(message)) {
          console.log('[WhatsApp] Processing all movements request');
          const transactions = await storage.getTransactionsByOrganization(currentOrgId!);
          await sendAllMovementsInChunks(From, transactions, currentOrg.name);
          return;
        }
        
        // Handle informative queries (resumen, saldo, salud financiera, etc.)
        if (classifiedIntent.intent === 'query' && classifiedIntent.confidence >= 50) {
          console.log('[WhatsApp] Processing informative query:', message);
          const financialContext = await getFinancialContext(user.id, currentOrgId!);
          const userContext: UserContext = {
            name: user.name,
            preferredName: user.preferredName || null,
            email: user.email,
            accountType: user.accountType || 'business'
          };
          const aiResponse = await generateAIResponse(message, financialContext, currentOrg.name, userContext, true);
          await sendWhatsAppMessage(From, 
            `📍 *${currentOrg.name}*\n\n${aiResponse}`
          );
          return;
        }
      }

      // Determine which organization to use — la prioridad ya se aplicó al
      // entrar al handler (resolveWhatsappOrgId). El bot NO sobrescribe la
      // org default ni la última activa de la web acá.
      let organizationId: string = effectiveOrgId;
      let currentOrg = organizations.find(o => o.id === organizationId) || organizations[0];
      organizationId = currentOrg.id;
      effectiveOrgId = organizationId;

      console.log(`[WhatsApp] Using organization: ${currentOrg.name} (${organizationId})`);

      // Get or create conversation state
      const conversation = await getOrCreateConversation(user.id, organizationId!);
      const accounts = await storage.getAccountsByOrganization(organizationId!);
      
      // Task #290 — Foto de ticket suelta: si el usuario manda una imagen
      // y NO está en el paso `invoice_image` (donde la imagen es el
      // adjunto de una transacción ya en construcción), interpretamos la
      // foto como un comprobante: extraemos monto/descripción/categoría
      // con vision, guardamos la imagen y llevamos al usuario al resumen
      // pre-confirm. Antes el bot se quedaba mudo (caso reportado: Juan
      // mandó la foto y no recibió respuesta).
      const isImageMessage = !isAudioMessage
        && typeof MediaContentType0 === 'string'
        && MediaContentType0.startsWith('image/')
        && !!MediaUrl0;
      if (isImageMessage && conversation.currentStep !== 'invoice_image') {
        console.log(`[WhatsApp] Ticket image detected (${MediaContentType0}), extracting via vision...`);
        const ticket = await extractTicketFromImage(MediaUrl0, MediaContentType0);
        if (!ticket) {
          await sendWhatsAppMessage(
            From,
            `No pude leer la foto como comprobante. ¿Me la mandás más nítida o me escribís el movimiento (por ejemplo: "gasté 12.500 en supermercado")?`,
          );
          return;
        }

        // Bajamos los slots básicos y guardamos la imagen en object storage.
        let invoiceFileUrl: string | null = null;
        try {
          invoiceFileUrl = await saveWhatsAppImageToStorage(MediaUrl0, organizationId!, user.id);
        } catch (err) {
          console.error('[WhatsApp] Failed to save ticket image to storage:', err);
          // Seguimos el flujo aunque no podamos persistir la imagen — los
          // datos extraídos sirven igual y el usuario después puede
          // adjuntar la foto desde la web.
        }

        const detectedCurrency: 'ARS' | 'USD' | 'EUR' = (ticket.currency || 'ARS');
        const accountsInCurrency = accounts.filter(acc => {
          const accCur = (acc.currency || 'ARS').toUpperCase();
          if (detectedCurrency === 'USD') return accCur === 'USD' || accCur === 'USD_CASH';
          return accCur === detectedCurrency;
        });

        // 0 cuentas → no podemos avanzar.
        if (accounts.length === 0) {
          await sendWhatsAppMessage(
            From,
            `📍 *${currentOrg.name}*\n\n⚠️ No tenés cuentas configuradas. Entrá a aikestar.net y creá una cuenta primero para que pueda registrar el ticket.`,
          );
          return;
        }

        // Resolvemos cliente/proveedor a partir del emisor del comprobante.
        const ticketAmount = ticket.amount as number;
        const fakeExtracted: ExtractedSlots = {
          type: ticket.type,
          amount: ticketAmount,
          currency: detectedCurrency,
          currencyExplicit: false,
          description: ticket.description,
          hasInvoice: true,
          autoConfirm: false,
          clientName: ticket.type === 'income' ? ticket.supplierName : null,
          supplierName: ticket.type === 'expense' ? ticket.supplierName : null,
        };
        const resolvedCS = (fakeExtracted.clientName || fakeExtracted.supplierName)
          ? await resolveClientSupplier(organizationId!, fakeExtracted)
          : { clientId: null, clientName: null, supplierId: null, supplierName: null, notFoundMessages: [] as string[] };

        // Elegimos cuenta: 1 → única; multi pero 1 sola en la moneda detectada → esa.
        let chosenAccount: typeof accounts[number] | null = null;
        if (accounts.length === 1) chosenAccount = accounts[0];
        else if (accountsInCurrency.length === 1) chosenAccount = accountsInCurrency[0];

        const composedDesc = composeDescription(
          ticket.description,
          ticket.type,
          resolvedCS.clientName,
          resolvedCS.supplierName,
        );
        const finalDescription = capitalizeFirst(composedDesc || 'Compra con comprobante');

        const smart = await resolveSmartDefaults(
          user.id,
          organizationId!,
          ticket.type,
          finalDescription,
          true, // hasInvoice = true (mandó la foto)
          chosenAccount?.id || null,
          accounts,
          ticket.suggestedCategory,
        );

        const symbol = (detectedCurrency === 'USD') ? 'U$D' : (detectedCurrency === 'EUR') ? '€' : '$';
        const typeLabels: Record<string, string> = {
          income: '💵 Ingreso',
          expense: '💸 Gasto',
        };
        const imageNote = invoiceFileUrl ? '\n📎 Foto del ticket guardada' : '\n⚠️ No pude guardar la foto, pero registré los datos';

        if (chosenAccount) {
          await updateConversation(user.id, organizationId!, {
            slots: {
              type: ticket.type,
              amount: ticketAmount,
              currency: detectedCurrency,
              description: finalDescription,
              accountId: chosenAccount.id,
              accountName: chosenAccount.name,
              accountSource: 'auto',
              category: smart.category,
              categorySource: smart.sources.category || null,
              hasInvoice: true,
              invoiceSource: 'explicit',
              invoiceFileUrl: invoiceFileUrl,
              clientId: resolvedCS.clientId,
              clientName: resolvedCS.clientName,
              supplierId: resolvedCS.supplierId,
              supplierName: resolvedCS.supplierName,
              date: ticket.date,
            },
            currentStep: 'confirm',
          });

          const csLine = buildClientSupplierLine(resolvedCS.clientName, resolvedCS.supplierName);
          const categoryLine = buildCategoryLabel(smart.category, smart.sources.category);
          const dateLine = ticket.date ? `📅 ${ticket.date}\n` : '';

          for (const nf of resolvedCS.notFoundMessages) {
            await sendWhatsAppMessage(From, nf);
          }

          await sendWhatsAppMessage(
            From,
            `📍 *${currentOrg.name}*\n\n` +
            `Leí el comprobante:\n\n` +
            `${typeLabels[ticket.type]} de ${symbol}${ticketAmount.toLocaleString('es-AR')} ${detectedCurrency}\n` +
            `🏦 ${chosenAccount.name}\n` +
            `📝 ${finalDescription}\n` +
            csLine +
            (categoryLine ? `${categoryLine}\n` : '') +
            dateLine +
            `🧾 Con factura` +
            imageNote +
            `\n\n¿Confirmo? Respondé *sí* o *no*`,
          );
          return;
        }

        // Multi-cuenta ambiguo: dejamos los slots cargados (sin accountId)
        // y mandamos al usuario al paso `account` con sugerencias.
        const suggested = suggestAccounts(
          accountsInCurrency.length > 0 ? accountsInCurrency : accounts,
          ticket.type,
          detectedCurrency,
        );
        await updateConversation(user.id, organizationId!, {
          slots: {
            type: ticket.type,
            amount: ticketAmount,
            currency: detectedCurrency,
            description: finalDescription,
            accountId: null,
            accountName: null,
            accountSource: null,
            category: smart.category,
            categorySource: smart.sources.category || null,
            hasInvoice: true,
            invoiceSource: 'explicit',
            invoiceFileUrl: invoiceFileUrl,
            clientId: resolvedCS.clientId,
            clientName: resolvedCS.clientName,
            supplierId: resolvedCS.supplierId,
            supplierName: resolvedCS.supplierName,
            date: ticket.date,
          },
          currentStep: 'account',
          suggestedAccounts: suggested.map(s => ({ id: s.account.id, name: s.account.name })),
        });

        for (const nf of resolvedCS.notFoundMessages) {
          await sendWhatsAppMessage(From, nf);
        }

        const accountsList = formatAccountSuggestions(suggested);
        await sendWhatsAppMessage(
          From,
          `📍 *${currentOrg.name}*\n\n` +
          `Leí el comprobante: ${typeLabels[ticket.type]} de ${symbol}${ticketAmount.toLocaleString('es-AR')} ${detectedCurrency}.` +
          imageNote +
          `\n\n¿De qué cuenta lo registro?\n${accountsList}`,
        );
        return;
      }

      // Check for cancel/reset commands
      if (['cancelar', 'cancel', 'reiniciar', 'empezar de nuevo', 'olvidalo', 'olvídalo'].some(cmd => message.toLowerCase().includes(cmd))) {
        await resetConversation(user.id, organizationId!);
        await sendWhatsAppMessage(From, 
          `👍 Dale, cancelado. ¿En qué te puedo ayudar?`
        );
        return;
      }

      // Check for preference configuration commands
      const prefLower = message.toLowerCase().trim();
      
      if (/^mis\s+prefer/i.test(prefLower) || /^ver\s+prefer/i.test(prefLower) || /^preferencias$/i.test(prefLower)) {
        const prefs = await storage.getWhatsappPreferences(user.id, organizationId!);
        if (!prefs || (!prefs.preferredAccountId && !prefs.preferredExpenseCategory && !prefs.preferredIncomeCategory && prefs.defaultHasInvoice === null)) {
          await sendWhatsAppMessage(From, 
            `⚙️ No tenés preferencias configuradas todavía.\n\n` +
            `Podés decirme:\n` +
            `• "mi cuenta preferida es [nombre]"\n` +
            `• "para gastos usá categoría [nombre]"\n` +
            `• "siempre sin factura"\n\n` +
            `O configurarlas desde aikestar.net → Configuración`
          );
        } else {
          let prefLines = '⚙️ *Tus preferencias:*\n\n';
          if (prefs.preferredAccountId) {
            const accs = await storage.getAccountsByOrganization(organizationId!);
            const prefAcc = accs.find(a => a.id === prefs.preferredAccountId);
            prefLines += `🏦 Cuenta preferida: *${prefAcc?.name || 'Eliminada'}*\n`;
          }
          if (prefs.preferredExpenseCategory) prefLines += `📁 Categoría gastos: *${prefs.preferredExpenseCategory}*\n`;
          if (prefs.preferredIncomeCategory) prefLines += `📁 Categoría ingresos: *${prefs.preferredIncomeCategory}*\n`;
          if (prefs.defaultHasInvoice !== null) prefLines += `🧾 Factura: *${prefs.defaultHasInvoice ? 'Siempre con factura' : 'Siempre sin factura'}*\n`;
          prefLines += `\nPara cambiar algo, decime qué querés modificar`;
          await sendWhatsAppMessage(From, prefLines);
        }
        return;
      }
      
      if (/^(borrar|resetear|eliminar)\s+prefer/i.test(prefLower)) {
        await storage.upsertWhatsappPreferences(user.id, organizationId!, {
          preferredAccountId: null,
          preferredCurrency: null,
          preferredExpenseCategory: null,
          preferredIncomeCategory: null,
          defaultHasInvoice: null,
        });
        clearPatternCache(user.id, organizationId!);
        await sendWhatsAppMessage(From, 
          `✅ Preferencias eliminadas. Vuelvo a usar los valores por defecto.\n\n¿En qué te puedo ayudar?`
        );
        return;
      }
      
      const prefAccountMatch = prefLower.match(/(?:mi\s+cuenta\s+preferida\s+(?:es|sea)|us[aá]\s+siempre|prefer[io]\s+(?:la\s+)?cuenta|cuenta\s+por\s+defecto)\s+(.+)/i);
      if (prefAccountMatch) {
        const accountName = prefAccountMatch[1].trim().replace(/^(la\s+)?/, '');
        const accs = await storage.getAccountsByOrganization(organizationId!);
        const matched = accs.find(a => a.name.toLowerCase().includes(accountName.toLowerCase()));
        if (matched) {
          await storage.upsertWhatsappPreferences(user.id, organizationId!, { preferredAccountId: matched.id });
          clearPatternCache(user.id, organizationId!);
          await sendWhatsAppMessage(From, 
            `✅ ¡Listo! De ahora en adelante voy a usar *${matched.name}* como tu cuenta preferida.\n\n¿En qué te puedo ayudar?`
          );
        } else {
          const accList = accs.map(a => `• ${a.name}`).join('\n');
          await sendWhatsAppMessage(From, 
            `No encontré esa cuenta 🤔\n\nTus cuentas:\n${accList}\n\nDecime el nombre exacto`
          );
        }
        return;
      }
      
      const prefCategoryMatch = prefLower.match(/para\s+(gastos?|ingresos?)\s+us[aá]\s+(?:la\s+)?categor[ií]a\s+(.+)/i);
      if (prefCategoryMatch) {
        const isExpense = prefCategoryMatch[1].startsWith('gasto');
        const categoryName = capitalizeFirst(prefCategoryMatch[2].trim());
        const updates = isExpense 
          ? { preferredExpenseCategory: categoryName }
          : { preferredIncomeCategory: categoryName };
        await storage.upsertWhatsappPreferences(user.id, organizationId!, updates);
        clearPatternCache(user.id, organizationId!);
        await sendWhatsAppMessage(From, 
          `✅ ¡Listo! Para ${isExpense ? 'gastos' : 'ingresos'} voy a usar la categoría *${categoryName}* por defecto.\n\n¿En qué te puedo ayudar?`
        );
        return;
      }
      
      if (/siempre\s+(sin|con)\s+factura/i.test(prefLower)) {
        const withInvoice = /siempre\s+con\s+factura/i.test(prefLower);
        await storage.upsertWhatsappPreferences(user.id, organizationId!, { defaultHasInvoice: withInvoice });
        clearPatternCache(user.id, organizationId!);
        await sendWhatsAppMessage(From, 
          `✅ ¡Listo! De ahora en adelante los movimientos van a ser *${withInvoice ? 'con' : 'sin'} factura* por defecto.\n\n¿En qué te puedo ayudar?`
        );
        return;
      }

      // Check for future/recurring transaction intent - redirect to web
      const futureKeywords = ['futuro', 'futuros', 'recurrente', 'recurrentes', 'programado', 'programar', 'programada', 'mensual', 'semanal', 'quincenal', 'agenda', 'agendar'];
      const msgLower = message.toLowerCase();
      const isFutureIntent = futureKeywords.some(keyword => msgLower.includes(keyword));
      if (isFutureIntent) {
        await resetConversation(user.id, organizationId!);
        await sendWhatsAppMessage(From, 
          `📅 Los movimientos futuros o recurrentes se configuran desde la web.\n\n` +
          `Ingresá a *aikestar.net* para programarlos.\n\n` +
          `¿Querés registrar un movimiento de hoy?`
        );
        return;
      }

      // Check for "todos mis movimientos" request (no active conversation) - bypass AI
      const noActiveConversation = conversation.slots.type === null && conversation.slots.amount === null;
      if (noActiveConversation && isAllMovementsRequest(message)) {
        console.log('[WhatsApp] Processing all movements request (no active flow)');
        const transactions = await storage.getTransactionsByOrganization(organizationId!);
        await sendAllMovementsInChunks(From, transactions, currentOrg.name);
        return;
      }
      
      // Check for informative queries when NO active conversation
      // This handles "dame un resumen", "cual es mi saldo", "salud financiera", etc.
      if (noActiveConversation && isNewQueryMessage(message)) {
        console.log('[WhatsApp] Processing informative query (no active flow):', message);
        const financialContext = await getFinancialContext(user.id, organizationId!);
        const userContext: UserContext = {
          name: user.name,
          preferredName: user.preferredName || null,
          email: user.email,
          accountType: user.accountType || 'business'
        };
        const aiResponse = await generateAIResponse(message, financialContext, currentOrg.name, userContext, true);
        await sendWhatsAppMessage(From, 
          `📍 *${currentOrg.name}*\n\n${aiResponse}`
        );
        return;
      }

      // PRIORITY: Check for org change request during ANY active flow
      // This allows users to switch orgs even in the middle of invoice/account steps
      const hasActiveFlow = conversation.slots.type !== null || conversation.slots.amount !== null;
      if (hasActiveFlow) {
        const orgsList = organizations.map(o => ({ id: o.id, name: o.name }));
        
        // Check if user wants to switch org explicitly
        const orgSwitchInFlow = detectOrgSwitchCommand(message);
        if (orgSwitchInFlow) {
          // Use fuzzy matching for better results
          const match = findBestOrgMatch(orgSwitchInFlow, orgsList);
          
          if (match && match.score > 40) {
            // Task #207: borrar (no recrear) la conversación de la org vieja
            // para que findActiveConversationOrgId() no la siga viendo activa.
            await clearConversation(user.id, organizationId!);
            // Cambio LOCAL a la conversación; no persistimos en DB.
            organizationId = match.org.id;
            effectiveOrgId = match.org.id;
            currentOrg = organizations.find(o => o.id === match.org.id) || currentOrg;
            // Sembrar conversación en la nueva org para próxima vuelta.
            await getOrCreateConversation(user.id, match.org.id);
            const summary = await getOrganizationSummary(match.org.id);
            await sendWhatsAppMessage(From, 
              `✅ ¡Cambiado a *${match.org.name}*!\n\n` +
              `${summary}\n\n` +
              `¿Qué querés hacer?`
            );
          } else {
            const orgList = organizations.map(o => {
              const isCurrent = o.id === organizationId;
              return `${isCurrent ? '👉 ' : '• '}${o.name}${isCurrent ? ' (actual)' : ''}`;
            }).join('\n');
            await sendWhatsAppMessage(From, 
              `No encontré esa organización 🤔\n\nTus organizaciones son:\n${orgList}\n\n` +
              `Escribí el nombre o parte del nombre`
            );
          }
          return;
        }
        
        // Check if user just typed an org name directly (without "cambiar a")
        // Use fuzzy matching instead of exact match
        const typedOrgName = message.trim();
        if (typedOrgName.length >= 3 && !typedOrgName.match(/^\d+$/)) {
          const fuzzyMatch = findBestOrgMatch(typedOrgName, orgsList);
          if (fuzzyMatch && fuzzyMatch.score > 50 && fuzzyMatch.org.id !== organizationId) {
            // Task #207: borrar (no recrear) la conversación de la org vieja
            // para que findActiveConversationOrgId() no la siga viendo activa.
            await clearConversation(user.id, organizationId!);
            // Cambio LOCAL a la conversación; no persistimos en DB.
            organizationId = fuzzyMatch.org.id;
            effectiveOrgId = fuzzyMatch.org.id;
            currentOrg = organizations.find(o => o.id === fuzzyMatch.org.id) || currentOrg;
            // Sembrar conversación en la nueva org para próxima vuelta.
            await getOrCreateConversation(user.id, fuzzyMatch.org.id);
            const summary = await getOrganizationSummary(fuzzyMatch.org.id);
            await sendWhatsAppMessage(From, 
              `✅ ¡Cambiado a *${fuzzyMatch.org.name}*!\n\n` +
              `${summary}\n\n` +
              `¿Qué querés hacer?`
            );
            return;
          }
        }
        
        // PRIORITY: When in confirm or account step, check for account change intent FIRST
        // "cuenta" in this context means financial account, not organization
        if (conversation.currentStep === 'confirm' || conversation.currentStep === 'account') {
          const accountIntent = detectEditIntent(message);
          if (accountIntent.field === 'account') {
            const suggestions = suggestAccounts(accounts, conversation.slots.type, conversation.slots.currency);
            const suggestedAccountsList = suggestions.map(s => ({ id: s.account.id, name: s.account.name }));
            const accountList = formatAccountSuggestions(suggestions);
            
            if (accountIntent.value) {
              const matchedAccount = accounts.find(a => 
                a.name.toLowerCase().includes(accountIntent.value!.toLowerCase())
              );
              if (matchedAccount) {
                await updateConversation(user.id, organizationId!, {
                  slots: { accountId: matchedAccount.id, accountName: matchedAccount.name },
                  currentStep: 'confirm',
                });
                const slots = (await getOrCreateConversation(user.id, organizationId!)).slots;
                const symbol = (slots.currency === 'USD') ? 'U$D' : (slots.currency === 'EUR') ? '€' : '$';
                const typeLabel = slots.type === 'expense' ? 'gasto' : 
                                 slots.type === 'income' ? 'ingreso' :
                                 slots.type === 'receivable' ? 'por cobrar' : 'por pagar';
                await sendWhatsAppMessage(From, 
                  `✅ Cambiado a *${matchedAccount.name}*\n\n` +
                  `${typeLabel} de ${symbol}${slots.amount!.toLocaleString('es-AR')}\n` +
                  `📝 ${slots.description}\n\n` +
                  `¿Confirmo? Respondé *sí* o *no*`
                );
                return;
              }
            }
            
            await updateConversation(user.id, organizationId!, {
              currentStep: 'account',
              suggestedAccounts: suggestedAccountsList
            });
            await sendWhatsAppMessage(From, 
              `🏦 ¿A qué cuenta querés cambiarlo?\n\n${accountList}\n\nRespondé con el número o nombre`
            );
            return;
          }
        }

        // Check for generic "cambiar org" requests during flow
        if (detectGenericOrgSwitchRequest(message)) {
          const orgList = organizations.map(o => {
            const isCurrent = o.id === organizationId;
            return `${isCurrent ? '👉 ' : '• '}${o.name}${isCurrent ? ' (actual)' : ''}`;
          }).join('\n');
          await sendWhatsAppMessage(From, 
            `📋 *¿A qué organización querés cambiar?*\n\n${orgList}\n\n` +
            `Escribí el nombre o parte del nombre`
          );
          return;
        }
      }

      // Check for contextual "no" response after completing a transaction
      // When user says "no" to "¿Querés registrar otro movimiento?", respond naturally
      if (conversation.justCompletedTransaction) {
        // Normalize message: remove punctuation and extra spaces for better matching
        const lowerMsg = message.toLowerCase().trim();
        const normalizedMsg = lowerMsg.replace(/[,\.!\?¿¡]/g, '').replace(/\s+/g, ' ').trim();
        
        // Only match short "no" responses (max 25 chars) to avoid capturing longer messages
        // that just happen to contain "no" (e.g., "no tengo factura pero gasté 5000")
        const shortNoVariants = ['no', 'nop', 'nope', 'na', 'nah', 'nel', 'nada', 'no gracias', 'no grax', 'no thanks'];
        const phraseNoVariants = ['por ahora no', 'ahora no', 'despues', 'después', 'luego', 'mas tarde', 'más tarde', 'todo bien', 'estoy bien', 'listo gracias'];
        const isShortNo = shortNoVariants.includes(normalizedMsg);
        const isPhraseNo = normalizedMsg.length <= 25 && phraseNoVariants.some(v => normalizedMsg === v || normalizedMsg.startsWith(v));
        
        if (isShortNo || isPhraseNo) {
          // Clear the flag and respond contextually
          await updateConversation(user.id, organizationId!, { justCompletedTransaction: false });
          await sendWhatsAppMessage(From, getPostTransactionNoResponse());
          return;
        }
        
        // If they say something else (like a new transaction), clear the flag and continue
        await updateConversation(user.id, organizationId!, { justCompletedTransaction: false });
      }

      // Check if we're waiting for user to decide if they want to continue a paused flow
      if (conversation.waitingForContinueDecision && conversation.pausedFlow) {
        const lowerMsg = message.toLowerCase().trim();
        const normalizedMsg = lowerMsg.replace(/[,\.!\?¿¡]/g, '').replace(/\s+/g, ' ').trim();
        
        const wantsToContinue = ['si', 'sí', 'dale', 'ok', 'continuar', 'seguir', 'retomar'].some(v => normalizedMsg === v || normalizedMsg.startsWith(v));
        const wantsToCancel = ['no', 'cancelar', 'olvidalo', 'olvídalo', 'nada', 'dejalo'].some(v => normalizedMsg === v || normalizedMsg.startsWith(v));
        
        if (wantsToContinue) {
          // Restore the paused flow
          const pausedFlow = conversation.pausedFlow;
          await updateConversation(user.id, organizationId!, {
            slots: pausedFlow.slots,
            currentStep: pausedFlow.currentStep,
            suggestedAccounts: pausedFlow.suggestedAccounts,
            pausedFlow: null,
            waitingForContinueDecision: false,
          });
          
          // Show where we left off
          const slots = pausedFlow.slots;
          const typeLabels: Record<string, string> = {
            income: 'ingreso',
            expense: 'gasto',
            receivable: 'por cobrar',
            payable: 'por pagar'
          };
          const symbol = (slots.currency === 'USD') ? 'U$D' : (slots.currency === 'EUR') ? '€' : '$';
          
          // Resume at the right step
          if (pausedFlow.currentStep === 'invoice') {
            await sendWhatsAppMessage(From, 
              `👍 Retomamos: ${typeLabels[slots.type!]} de ${symbol}${slots.amount!.toLocaleString('es-AR')}\n\n` +
              `🧾 ¿Tenés factura de esto? Respondé *sí* o *no*`
            );
          } else if (pausedFlow.currentStep === 'invoice_number') {
            await sendWhatsAppMessage(From, 
              `👍 Retomamos: ${typeLabels[slots.type!]} de ${symbol}${slots.amount!.toLocaleString('es-AR')}\n\n` +
              `¿Cuál es el *número de factura*?\n\n` +
              `(Si no lo tenés a mano, escribí *omitir*)`
            );
          } else if (pausedFlow.currentStep === 'invoice_image') {
            await sendWhatsAppMessage(From, 
              `👍 Retomamos: ${typeLabels[slots.type!]} de ${symbol}${slots.amount!.toLocaleString('es-AR')}\n\n` +
              `¿Querés adjuntar una *foto o archivo* de la factura?\n\n` +
              `• Enviá la *imagen/PDF*\n` +
              `• O respondé *no* para continuar sin adjunto`
            );
          } else if (pausedFlow.currentStep === 'account') {
            const accountList = pausedFlow.suggestedAccounts?.map((a, i) => `${i + 1}. ${a.name}`).join('\n') || '';
            await sendWhatsAppMessage(From, 
              `👍 Retomamos: ${typeLabels[slots.type!]} de ${symbol}${slots.amount!.toLocaleString('es-AR')}\n\n` +
              `¿De qué cuenta?\n${accountList}\n\n` +
              `Respondé con el número o nombre de la cuenta`
            );
          } else if (pausedFlow.currentStep === 'confirm') {
            const accountLine = slots.accountName ? buildAccountLabel(slots.accountName, slots.accountSource || undefined) + '\n' : '';
            await sendWhatsAppMessage(From, 
              `👍 Retomamos:\n\n` +
              `${typeLabels[slots.type!]} de ${symbol}${slots.amount!.toLocaleString('es-AR')}\n` +
              `📝 ${slots.description}\n` +
              accountLine +
              `\n¿Confirmo? Respondé *sí* o *no*`
            );
          } else {
            await sendWhatsAppMessage(From, 
              `👍 Retomamos el movimiento. ¿En qué estábamos?`
            );
          }
          return;
        } else if (wantsToCancel) {
          // Cancel the paused flow
          await updateConversation(user.id, organizationId!, {
            pausedFlow: null,
            waitingForContinueDecision: false,
          });
          await resetConversation(user.id, organizationId!);
          await sendWhatsAppMessage(From, 
            `👍 Listo, lo cancelé. ¿En qué te puedo ayudar?`
          );
          return;
        }
        // If not clear, they might be starting something new - clear the pause and continue
        await updateConversation(user.id, organizationId!, {
          pausedFlow: null,
          waitingForContinueDecision: false,
        });
        await resetConversation(user.id, organizationId!);
      }

      // Check for new query in the middle of any active conversation step
      // This allows users to ask "cuánto gasté" even when in account/invoice/confirm steps
      const hasActiveConversation = conversation.slots.type !== null || conversation.slots.amount !== null;
      if (hasActiveConversation && isNewQueryMessage(message)) {
        // User is asking a new question - PAUSE current flow (don't cancel)
        const pausedFlow = {
          slots: { ...conversation.slots },
          currentStep: conversation.currentStep,
          suggestedAccounts: conversation.suggestedAccounts,
        };
        
        // Get AI response for the question
        const financialContext = await getFinancialContext(user.id, organizationId!);
        const userContext: UserContext = {
          name: user.name,
          preferredName: user.preferredName || null,
          email: user.email,
          accountType: user.accountType || 'business'
        };
        const aiResponse = await generateAIResponse(message, financialContext, currentOrg.name, userContext, true);
        
        // Store paused flow and mark as waiting for decision
        await resetConversation(user.id, organizationId!);
        await updateConversation(user.id, organizationId!, {
          pausedFlow,
          waitingForContinueDecision: true,
        });
        
        // Build summary of what was in progress
        const typeLabels: Record<string, string> = {
          income: 'ingreso',
          expense: 'gasto',
          receivable: 'por cobrar',
          payable: 'por pagar'
        };
        const symbol = (pausedFlow.slots.currency === 'USD') ? 'U$D' : (pausedFlow.slots.currency === 'EUR') ? '€' : '$';
        const flowSummary = pausedFlow.slots.type && pausedFlow.slots.amount 
          ? `${typeLabels[pausedFlow.slots.type]} de ${symbol}${pausedFlow.slots.amount.toLocaleString('es-AR')}`
          : 'el movimiento';
        
        await sendWhatsAppMessage(From, 
          `${aiResponse}\n\n` +
          `---\n` +
          `💡 Tenías pendiente: *${flowSummary}*\n` +
          `¿Querés continuar? Respondé *sí* o *no*`
        );
        return;
      }

      // Global currency correction handler - works across ALL wizard steps
      if (conversation.currentStep !== null && conversation.slots.type && conversation.slots.amount) {
        const editIntent = detectEditIntent(message);
        if (editIntent.field === 'currency' && editIntent.value) {
          const newCurrency = editIntent.value as string;
          const currencyName = newCurrency === 'USD' ? 'dólares' : newCurrency === 'EUR' ? 'euros' : 'pesos';
          const currencySymbol = newCurrency === 'USD' ? 'U$D' : newCurrency === 'EUR' ? '€' : '$';
          const typeLabels: Record<string, string> = {
            income: 'ingreso', expense: 'gasto', receivable: 'por cobrar', payable: 'por pagar'
          };
          
          const needsAccount = conversation.slots.type === 'income' || conversation.slots.type === 'expense';
          
          if (needsAccount) {
            const accountsInCurrency = accounts.filter(acc => {
              const accCurrency = (acc.currency || 'ARS').toUpperCase();
              if (newCurrency === 'USD') return accCurrency === 'USD' || accCurrency === 'USD_CASH';
              return accCurrency === newCurrency;
            });
            
            if (accountsInCurrency.length === 0) {
              await resetConversation(user.id, organizationId!);
              await sendWhatsAppMessage(From, 
                `📍 *${currentOrg.name}*\n\n` +
                `⚠️ No tenés cuentas en ${currencyName} en esta organización.\n\n` +
                `Para registrar movimientos en ${currencyName}, primero creá una cuenta en esa moneda.\n\n` +
                `👉 Entrá a *aikestar.net* → Cuentas → Nueva cuenta → Elegí ${newCurrency} como moneda`
              );
              return;
            }
            
            if (accountsInCurrency.length === 1) {
              let correctionNextStep: ConversationState['currentStep'];
              const hasDesc = !!conversation.slots.description;
              const invoiceAlreadyKnown = conversation.slots.hasInvoice !== null && conversation.slots.hasInvoice !== undefined;
              
              if (!hasDesc) {
                correctionNextStep = 'description';
              } else if (!invoiceAlreadyKnown) {
                correctionNextStep = 'invoice';
              } else {
                correctionNextStep = 'confirm';
              }
              
              await updateConversation(user.id, organizationId!, {
                slots: {
                  currency: newCurrency,
                  accountId: accountsInCurrency[0].id,
                  accountName: accountsInCurrency[0].name,
                },
                currentStep: correctionNextStep
              });
              
              if (correctionNextStep === 'confirm') {
                const invoiceLabel = conversation.slots.hasInvoice ? 'Con factura' : 'Sin factura';
                await sendWhatsAppMessage(From, 
                  `📍 *${currentOrg.name}*\n\n` +
                  `✅ Corregido a *${currencyName}*\n\n` +
                  `Perfecto, te resumo:\n\n` +
                  `💸 ${typeLabels[conversation.slots.type!]} de ${currencySymbol}${conversation.slots.amount!.toLocaleString('es-AR')} ${newCurrency}\n` +
                  `🏦 ${accountsInCurrency[0].name}\n` +
                  `📝 ${conversation.slots.description}\n` +
                  `🧾 ${invoiceLabel}\n\n` +
                  `¿Confirmo? Respondé *sí* o *no* 😊`
                );
              } else if (correctionNextStep === 'invoice') {
                await sendWhatsAppMessage(From, 
                  `📍 *${currentOrg.name}*\n\n` +
                  `✅ Corregido a *${currencyName}*\n` +
                  `${currencySymbol}${conversation.slots.amount!.toLocaleString('es-AR')} de ${typeLabels[conversation.slots.type!]}\n` +
                  `🏦 *${accountsInCurrency[0].name}*\n` +
                  `📝 *${conversation.slots.description}*\n\n` +
                  `🧾 ¿Tenés factura de esto? Respondé *sí* o *no*`
                );
              } else {
                await sendWhatsAppMessage(From, 
                  `📍 *${currentOrg.name}*\n\n` +
                  `✅ Corregido a *${currencyName}*\n` +
                  `${currencySymbol}${conversation.slots.amount!.toLocaleString('es-AR')} de ${typeLabels[conversation.slots.type!]}\n` +
                  `🏦 *${accountsInCurrency[0].name}*\n\n` +
                  `📝 ¿Cuál es el detalle de este movimiento?`
                );
              }
              return;
            }
            
            const suggestions = suggestAccounts(accountsInCurrency, conversation.slots.type, newCurrency);
            const suggestedAccountsList = suggestions.map(s => ({ id: s.account.id, name: s.account.name }));
            const accountList = formatAccountSuggestions(suggestions);
            await updateConversation(user.id, organizationId!, {
              slots: { currency: newCurrency },
              currentStep: 'account',
              suggestedAccounts: suggestedAccountsList
            });
            await sendWhatsAppMessage(From, 
              `📍 *${currentOrg.name}*\n\n` +
              `✅ Corregido a *${currencyName}*\n` +
              `${currencySymbol}${conversation.slots.amount!.toLocaleString('es-AR')} de ${typeLabels[conversation.slots.type!]} 💸\n\n` +
              `¿De qué cuenta?\n${accountList}\n\n` +
              `Respondé con el número o nombre de la cuenta`
            );
            return;
          } else {
            let correctionNextStep: ConversationState['currentStep'];
            const hasDesc = !!conversation.slots.description;
            const invoiceAlreadyKnown = conversation.slots.hasInvoice !== null && conversation.slots.hasInvoice !== undefined;
            
            if (!hasDesc) {
              correctionNextStep = 'description';
            } else if (!invoiceAlreadyKnown) {
              correctionNextStep = 'invoice';
            } else {
              correctionNextStep = 'confirm';
            }
            
            await updateConversation(user.id, organizationId!, {
              slots: { currency: newCurrency },
              currentStep: correctionNextStep
            });
            
            if (correctionNextStep === 'confirm') {
              const invoiceLabel = conversation.slots.hasInvoice ? 'Con factura' : 'Sin factura';
              await sendWhatsAppMessage(From, 
                `📍 *${currentOrg.name}*\n\n` +
                `✅ Corregido a *${currencyName}*\n\n` +
                `Perfecto, te resumo:\n\n` +
                `${typeLabels[conversation.slots.type!]} de ${currencySymbol}${conversation.slots.amount!.toLocaleString('es-AR')} ${newCurrency}\n` +
                `📝 ${conversation.slots.description}\n` +
                `🧾 ${invoiceLabel}\n\n` +
                `¿Confirmo? Respondé *sí* o *no* 😊`
              );
            } else if (correctionNextStep === 'invoice') {
              await sendWhatsAppMessage(From, 
                `📍 *${currentOrg.name}*\n\n` +
                `✅ Corregido a *${currencyName}*\n` +
                `${currencySymbol}${conversation.slots.amount!.toLocaleString('es-AR')} de ${typeLabels[conversation.slots.type!]}\n` +
                `📝 *${conversation.slots.description}*\n\n` +
                `🧾 ¿Tenés factura de esto? Respondé *sí* o *no*`
              );
            } else {
              await sendWhatsAppMessage(From, 
                `📍 *${currentOrg.name}*\n\n` +
                `✅ Corregido a *${currencyName}*\n` +
                `${currencySymbol}${conversation.slots.amount!.toLocaleString('es-AR')} de ${typeLabels[conversation.slots.type!]}\n\n` +
                `📝 ¿Cuál es el detalle de este movimiento?`
              );
            }
            return;
          }
        }
      }

      // Check for confirmation responses
      if (conversation.currentStep === 'confirm') {
        // Safety check: validate all required slots before confirming
        const requiredStep = getNextStep(conversation.slots);
        if (requiredStep !== 'confirm') {
          await updateConversation(user.id, organizationId!, { currentStep: requiredStep });
          const typeLabel = conversation.slots.type === 'expense' ? 'gasto' : 
                           conversation.slots.type === 'income' ? 'ingreso' :
                           conversation.slots.type === 'receivable' ? 'cobro' : 'pago';
          if (requiredStep === 'description') {
            await sendWhatsAppMessage(From, `📝 ¿Cuál es el detalle de este ${typeLabel}?`);
          } else if (requiredStep === 'account') {
            const suggestions = suggestAccounts(accounts, conversation.slots.type, conversation.slots.currency);
            const suggestedAccountsList = suggestions.map(s => ({ id: s.account.id, name: s.account.name }));
            await updateConversation(user.id, organizationId!, { suggestedAccounts: suggestedAccountsList });
            const accountList = formatAccountSuggestions(suggestions);
            await sendWhatsAppMessage(From, `¿De qué cuenta?\n${accountList}`);
          } else if (requiredStep === 'amount') {
            await sendWhatsAppMessage(From, `¿Cuánto fue el ${typeLabel}?`);
          } else if (requiredStep === 'currency') {
            await sendWhatsAppMessage(From, `¿En qué moneda? (pesos/dólares)`);
          } else {
            await sendWhatsAppMessage(From, `Falta información. ¿Podés darme más detalles?`);
          }
          return;
        }
        
        const lowerMsg = message.toLowerCase().trim();
        const isConfirm = ['si', 'sí', 'dale', 'ok', 'confirmo', 'confirmar', 'listo', 'perfecto', '1'].includes(lowerMsg);
        const isCancel = ['no', 'cancelar', 'cancel', '2'].includes(lowerMsg);
        
        // Check for edit intent before confirm/cancel
        const editIntent = detectEditIntent(message);
        if (editIntent.field === 'cancel') {
          await resetConversation(user.id, organizationId!);
          await sendWhatsAppMessage(From, `👍 Cancelado. ¿En qué te puedo ayudar?`);
          return;
        }
        if (editIntent.field === 'amount') {
          await sendWhatsAppMessage(From, 
            `Para cambiar el monto, cancelá con *cancelar* y empezá de nuevo.\n\n` +
            `O confirmá el actual con *sí* o *no*`
          );
          return;
        }
        if (editIntent.field === 'type') {
          await sendWhatsAppMessage(From, 
            `Para cambiar el tipo, cancelá con *cancelar* y empezá de nuevo.\n\n` +
            `O confirmá con *sí* o *no*`
          );
          return;
        }
        if (editIntent.field === 'account') {
          // User wants to change account - go back to account selection
          const suggestions = suggestAccounts(accounts, conversation.slots.type, conversation.slots.currency);
          const suggestedAccountsList = suggestions.map(s => ({ id: s.account.id, name: s.account.name }));
          const accountList = formatAccountSuggestions(suggestions);
          
          if (editIntent.value) {
            const matchedAccount = accounts.find(a => 
              a.name.toLowerCase().includes(editIntent.value!.toLowerCase())
            );
            if (matchedAccount) {
              await updateConversation(user.id, organizationId!, {
                slots: { accountId: matchedAccount.id, accountName: matchedAccount.name },
              });
              const slots = (await getOrCreateConversation(user.id, organizationId!)).slots;
              const symbol = (slots.currency === 'USD') ? 'U$D' : (slots.currency === 'EUR') ? '€' : '$';
              await sendWhatsAppMessage(From, 
                `✅ Cambiado a *${matchedAccount.name}*\n\n` +
                `Ahora sí, ¿confirmo ${symbol}${slots.amount!.toLocaleString('es-AR')} de ${slots.type}? Respondé *sí* o *no*`
              );
              return;
            }
          }
          
          await updateConversation(user.id, organizationId!, {
            currentStep: 'account',
            suggestedAccounts: suggestedAccountsList
          });
          await sendWhatsAppMessage(From, 
            `¿A qué cuenta querés cambiar?\n\n${accountList}\n\nRespondé con el número o nombre`
          );
          return;
        }

        // Task #379: el usuario quiere cambiar la categoría desde la
        // confirmación ("es para la categoría transporte", "ponelo en comida",
        // "no, quiero cambiar la categoría").
        if (editIntent.field === 'category') {
          const slots = conversation.slots;
          const catType: 'income' | 'expense' =
            slots.type === 'income' || slots.type === 'receivable' ? 'income' : 'expense';
          const cats = await storage.getTransactionCategoriesByOrganization(organizationId!, catType);

          if (cats.length === 0) {
            await sendWhatsAppMessage(From,
              `No tenés categorías configuradas para este tipo de movimiento.\n\n` +
              `Confirmá con *sí* o cancelá con *cancelar*.`
            );
            return;
          }

          // Si el usuario dijo a qué categoría, intentamos mapearla al catálogo.
          if (editIntent.value) {
            const wanted = editIntent.value.toLocaleLowerCase('es-AR');
            const match =
              cats.find(c => c.name.toLocaleLowerCase('es-AR') === wanted) ||
              cats.find(c => {
                const n = c.name.toLocaleLowerCase('es-AR');
                return n.includes(wanted) || wanted.includes(n);
              });
            if (match) {
              await updateConversation(user.id, organizationId!, {
                slots: { category: match.name, categorySource: 'explicit' },
              });
              const symbol = (slots.currency === 'USD') ? 'U$D' : (slots.currency === 'EUR') ? '€' : '$';
              await sendWhatsAppMessage(From,
                `✅ Categoría cambiada a *${match.name}*\n\n` +
                `¿Confirmo ${symbol}${slots.amount!.toLocaleString('es-AR')} de ${slots.type}? Respondé *sí* o *no*`
              );
              return;
            }
          }

          // No entendimos o no hay match claro: mostramos la lista para elegir.
          const availableCats = cats.map(c => ({ id: c.id, name: c.name }));
          await updateConversation(user.id, organizationId!, {
            currentStep: 'category',
            availableCategories: availableCats,
          });
          const categoryList = availableCats.map((c, i) => `${i + 1}️⃣ ${c.name}`).join('\n');
          const notFoundNote = editIntent.value
            ? `No encontré una categoría que coincida con "${editIntent.value}".\n\n`
            : ``;
          await sendWhatsAppMessage(From,
            `${notFoundNote}¿A qué categoría querés cambiarlo?\n${categoryList}\n\nRespondé con el número o nombre`
          );
          return;
        }

        if (isConfirm) {
          const slots = conversation.slots;
          
          // Final validation: ensure all required data is complete before creating
          const finalStep = getNextStep(slots);
          if (finalStep !== 'confirm') {
            // Redirect to the required step
            await updateConversation(user.id, organizationId!, { currentStep: finalStep });
            await sendWhatsAppMessage(From, `⚠️ Falta información. Vamos a completar: ${finalStep}`);
            return;
          }
          
          // receivable/payable don't require accountId
          const needsAccount = slots.type === 'income' || slots.type === 'expense';
          const hasRequiredData = slots.type && slots.amount && (!needsAccount || slots.accountId);
          
          if (hasRequiredData) {
            const now = new Date();
            // Si tenemos fecha del ticket (Task #290) y es válida y reciente
            // (no futura, no más vieja que 365 días), la usamos para el
            // movimiento; si no, hoy.
            let txDate = argentinaTodayAtNoon();
            if (slots.date && /^\d{4}-\d{2}-\d{2}$/.test(slots.date)) {
              const parsed = new Date(`${slots.date}T12:00:00`);
              if (!isNaN(parsed.getTime())) {
                const diffDays = (now.getTime() - parsed.getTime()) / 86_400_000;
                if (diffDays >= 0 && diffDays <= 365) txDate = parsed;
              }
            }
            const isCompleted = slots.type === 'income' || slots.type === 'expense';
            // Task #286: envolvemos el INSERT en try/catch para que un fallo
            // (ej. categoría inexistente que igual termina violando NOT NULL)
            // no deje al bot mudo. Le respondemos al usuario que reintente.
            let created;
            try {
              created = await createWhatsAppTransaction({
                organizationId: organizationId!,
                accountId: slots.accountId,
                type: slots.type!,
                amount: String(slots.amount),
                currency: slots.currency || 'ARS',
                description: capitalizeFirst(slots.description || 'Movimiento por WhatsApp'),
                category: slots.category || 'General',
                date: txDate,
                imputationDate: txDate,
                status: isCompleted ? 'completed' : 'scheduled',
                createdBy: user.id,
                completedBy: isCompleted ? user.id : null,
                completedAt: isCompleted ? now : null,
                hasInvoice: slots.hasInvoice || false,
                invoiceType: slots.invoiceType || null,
                invoiceNumber: slots.invoiceNumber && slots.invoiceNumber !== 'skipped' && slots.invoiceNumber.length > 0 ? slots.invoiceNumber : null,
                invoiceTaxId: slots.invoiceTaxId || null,
                invoiceFileUrl: slots.invoiceFileUrl && slots.invoiceFileUrl !== 'skipped' && slots.invoiceFileUrl.length > 0 ? slots.invoiceFileUrl : null,
                createdVia: 'whatsapp',
                clientId: slots.clientId,
                supplierId: slots.supplierId,
              }, user.id);
            } catch (insertErr) {
              console.error('[WhatsApp Confirm] createTransaction falló:', insertErr);
              await resetConversation(user.id, organizationId!);
              await sendWhatsAppMessage(From,
                `⚠️ No pude registrar la transacción. ¿Podés intentar de nuevo en un momento?`
              );
              return;
            }

            const typeLabels: Record<string, string> = {
              income: '💵 Ingreso',
              expense: '💸 Gasto',
              receivable: '📥 Por cobrar',
              payable: '📤 Por pagar'
            };
            const symbol = (slots.currency === 'USD') ? 'U$D' : (slots.currency === 'EUR') ? '€' : '$';
            const accountLine = slots.accountName ? buildAccountLabel(slots.accountName, slots.accountSource || undefined) + '\n' : '';
            const confirmCsLine = buildClientSupplierLine(slots.clientName, slots.supplierName);
            
            let invoiceLine = buildInvoiceLabel(slots.hasInvoice || false, slots.invoiceSource || undefined);
            if (slots.hasInvoice) {
              if (slots.invoiceNumber && slots.invoiceNumber !== 'skipped') {
                invoiceLine += ` (${slots.invoiceNumber})`;
              }
              if (slots.invoiceFileUrl && slots.invoiceFileUrl !== 'skipped') {
                invoiceLine += ' 📎';
              }
            }
            // Task #286: mostramos la categoría realmente persistida (puede
            // haber sido resuelta a una del catálogo si la sugerida no existía).
            const effectiveCategory = created.category || slots.category || 'General';
            const categorySource =
              effectiveCategory !== (slots.category || 'General') ? 'auto' : (slots.categorySource || undefined);
            const categoryLine = buildCategoryLabel(effectiveCategory, categorySource);

            await resetConversation(user.id, organizationId!);
            await updateConversation(user.id, organizationId!, { justCompletedTransaction: true });
            await sendWhatsAppMessage(From, 
              `✅ ¡Listo! Registrado en *${currentOrg.name}*\n\n` +
              `${typeLabels[slots.type!]}: ${symbol}${slots.amount!.toLocaleString('es-AR')} ${slots.currency || 'ARS'}\n` +
              `📝 ${slots.description}\n` +
              accountLine +
              confirmCsLine +
              (categoryLine ? `${categoryLine}\n` : '') +
              `${invoiceLine}\n\n` +
              `¿Querés registrar otro movimiento? 😊`
            );
            return;
          } else {
            // Missing required data - log and reset conversation
            console.log('[WhatsApp] Confirm failed - missing data:', {
              type: slots.type,
              amount: slots.amount,
              accountId: slots.accountId,
              needsAccount
            });
            await resetConversation(user.id, organizationId!);
            await sendWhatsAppMessage(From, 
              `⚠️ Hubo un problema con los datos. ¿Podés empezar de nuevo?\n\n` +
              `Escribí algo como "gasté 5000 en almuerzo" o "cobré 10000 de un cliente" 😊`
            );
            return;
          }
        } else if (isCancel) {
          await resetConversation(user.id, organizationId!);
          await sendWhatsAppMessage(From, 
            `👍 Cancelado. ¿Empezamos de nuevo?`
          );
          return;
        } else {
          // Invalid response - reprompt
          await sendWhatsAppMessage(From, 
            `¿Confirmás el movimiento? Respondé *sí* para registrar o *no* para cancelar`
          );
          return;
        }
      }

      // Check for currency selection response
      if (conversation.currentStep === 'currency') {
        const lowerMsg = message.toLowerCase().trim();
        
        // Check for cancel
        const editIntent = detectEditIntent(message);
        if (editIntent.field === 'cancel') {
          await resetConversation(user.id, organizationId!);
          await sendWhatsAppMessage(From, `👍 Cancelado. ¿En qué te puedo ayudar?`);
          return;
        }
        
        // Detect currency from response (with colloquial expressions)
        const isPesos = ['peso', 'pesos', 'ars', 'argentino', 'nacional', '1'].some(v => 
          lowerMsg === v || lowerMsg.includes(v)
        );
        const isDolares = ['dolar', 'dólar', 'dolares', 'dólares', 'usd', 'verde', 'verdes', 'blue', 'u$d', 'u$s', '2'].some(v => 
          lowerMsg === v || lowerMsg.includes(v)
        );
        
        if (isPesos || isDolares) {
          const selectedCurrency = isDolares ? 'USD' : 'ARS';
          const currencySymbol = isDolares ? 'U$D' : '$';
          const currencyLabel = isDolares ? 'dólares' : 'pesos';
          
          await updateConversation(user.id, organizationId!, {
            slots: { currency: selectedCurrency },
            currentStep: conversation.slots.type === 'income' || conversation.slots.type === 'expense' ? 'account' : 'category'
          });
          
          const typeLabels: Record<string, string> = {
            income: '💵 Ingreso',
            expense: '💸 Gasto',
            receivable: '📥 Por cobrar',
            payable: '📤 Por pagar'
          };
          
          // If receivable/payable, go directly to description step (skip category)
          if (conversation.slots.type === 'receivable' || conversation.slots.type === 'payable') {
            await updateConversation(user.id, organizationId!, {
              slots: { category: 'General' },
              currentStep: 'description'
            });
            await sendWhatsAppMessage(From, 
              `✅ ${currencySymbol}${conversation.slots.amount!.toLocaleString('es-AR')} en ${currencyLabel} 👍\n\n` +
              `📝 ¿Cuál es el detalle de este movimiento?`
            );
            return;
          }
          
          // If income/expense, check accounts in that currency
          const accountsInCurrency = accounts.filter(acc => {
            const accCurrency = (acc.currency || 'ARS').toUpperCase();
            if (selectedCurrency === 'USD') {
              return accCurrency === 'USD' || accCurrency === 'USD_CASH';
            }
            return accCurrency === selectedCurrency;
          });
          
          if (accountsInCurrency.length === 0) {
            await sendWhatsAppMessage(From, 
              `⚠️ No tenés cuentas en ${currencyLabel} en *${currentOrg.name}*.\n\n` +
              `Entrá a *aikestar.net* → Cuentas → Nueva cuenta para crear una.`
            );
            await resetConversation(user.id, organizationId!);
            return;
          }
          
          if (accountsInCurrency.length === 1) {
            // Auto-select the only account in that currency, then ask for description
            await updateConversation(user.id, organizationId!, {
              slots: { 
                accountId: accountsInCurrency[0].id, 
                accountName: accountsInCurrency[0].name,
                category: 'General'
              },
              currentStep: 'description'
            });
            await sendWhatsAppMessage(From, 
              `✅ ${currencySymbol}${conversation.slots.amount!.toLocaleString('es-AR')} en ${currencyLabel}\n` +
              `🏦 Lo anoto en *${accountsInCurrency[0].name}*\n\n` +
              `📝 ¿Cuál es el detalle de este movimiento?`
            );
            return;
          }
          
          // Multiple accounts - ask which one
          const suggestions = suggestAccounts(accountsInCurrency, conversation.slots.type, selectedCurrency);
          const suggestedAccountsList = suggestions.map(s => ({ id: s.account.id, name: s.account.name }));
          const accountList = formatAccountSuggestions(suggestions);
          
          await updateConversation(user.id, organizationId!, {
            currentStep: 'account',
            suggestedAccounts: suggestedAccountsList
          });
          
          await sendWhatsAppMessage(From, 
            `✅ ${currencySymbol}${conversation.slots.amount!.toLocaleString('es-AR')} en ${currencyLabel}\n\n` +
            `¿De qué cuenta?\n${accountList}\n\n` +
            `Respondé con el número o nombre de la cuenta`
          );
          return;
        }
        
        // Unclear response
        await sendWhatsAppMessage(From, 
          `¿En qué moneda? Respondé:\n\n` +
          `1️⃣ *Pesos* (ARS)\n` +
          `2️⃣ *Dólares* (USD)`
        );
        return;
      }

      // Check for account selection response
      if (conversation.currentStep === 'account') {
        console.log(`[WhatsApp] Account selection step - message: "${message}"`);
        // Use the suggested accounts from state if available, otherwise fall back to full list
        const accountsToCheck = conversation.suggestedAccounts || accounts.map(a => ({ id: a.id, name: a.name }));
        console.log(`[WhatsApp] Available accounts for selection:`, accountsToCheck.map((a, i) => `${i+1}. ${a.name}`).join(', '));
        const accountChoice = parseAccountChoice(message, accountsToCheck);
        console.log(`[WhatsApp] Parsed account choice:`, accountChoice ? `${accountChoice.name} (${accountChoice.id})` : 'null - no match');
        
        if (accountChoice) {
          await updateConversation(user.id, organizationId!, {
            slots: { 
              accountId: accountChoice.id, 
              accountName: accountChoice.name,
              accountSource: 'explicit',
              category: 'General'
            },
            suggestedAccounts: null // Clear suggestions after selection
          });
          // Move to next step (description or invoice)
          const updated = await getOrCreateConversation(user.id, organizationId!);
          const nextStep = getNextStep(updated.slots);
          
          console.log(`[WhatsApp] Account selected: ${accountChoice.name}, next step: ${nextStep}`);
          await updateConversation(user.id, organizationId!, { currentStep: nextStep });
          if (nextStep === 'description') {
            await sendWhatsAppMessage(From, 
              `Perfecto, en *${accountChoice.name}* 👍\n\n📝 ¿Cuál es el detalle de este movimiento?`
            );
            return;
          }
          if (nextStep === 'invoice') {
            await sendWhatsAppMessage(From, 
              `Perfecto, en *${accountChoice.name}* 👍\n\n¿Tenés factura de esto? Respondé *sí* o *no*`
            );
            return;
          }
          if (nextStep === 'confirm') {
            const symbol = (updated.slots.currency === 'USD') ? 'U$D' : (updated.slots.currency === 'EUR') ? '€' : '$';
            const typeLabel = updated.slots.type === 'expense' ? 'Gasto' : 
                             updated.slots.type === 'income' ? 'Ingreso' :
                             updated.slots.type === 'receivable' ? 'Por cobrar' : 'Por pagar';
            const acctCsLine = buildClientSupplierLine(updated.slots.clientName, updated.slots.supplierName);
            // Task #294: si venimos del flujo de foto suelta de ticket,
            // los slots ya traen `invoiceFileUrl` y `hasInvoice=true`.
            // Lo mostramos en el resumen para que quede claro que la
            // foto ya quedó guardada y NO vamos a volver a pedirla.
            const invoiceLine = (updated.slots.hasInvoice === true && updated.slots.invoiceFileUrl)
              ? `• 🧾 Con factura (foto guardada)\n`
              : '';
            await sendWhatsAppMessage(From, 
              `Perfecto, en *${accountChoice.name}* 👍\n\n` +
              `📋 *Resumen*:\n` +
              `• ${typeLabel}: ${symbol}${updated.slots.amount?.toLocaleString('es-AR')}\n` +
              `• ${updated.slots.description || 'Sin descripción'}\n` +
              `• Cuenta: ${accountChoice.name}\n` +
              invoiceLine +
              acctCsLine +
              `\n¿Confirmo? Respondé *sí* o *no*`
            );
            return;
          }
          // Fallback for any other case
          console.log(`[WhatsApp] Unexpected nextStep after account selection: ${nextStep}`);
          await sendWhatsAppMessage(From, 
            `Perfecto, en *${accountChoice.name}* 👍\n\n¿Tenés factura de esto? Respondé *sí* o *no*`
          );
          return;
        } else {
          // Before showing error, check if user might be referring to an ORGANIZATION (not a financial account)
          // In Argentine Spanish, "cuenta" is ambiguous - it can mean financial account OR organization
          if (organizations.length > 1) {
            const orgsList = organizations.map(o => ({ id: o.id, name: o.name }));
            const orgMatch = findBestOrgMatch(message, orgsList);
            
            if (orgMatch && orgMatch.score > 30 && orgMatch.org.id !== organizationId) {
              console.log(`[WhatsApp] Account step: detected org switch intent to "${orgMatch.org.name}" (score: ${orgMatch.score})`);
              const savedSlots = { ...conversation.slots };
              // Task #207: borrar (no recrear) la conversación de la org vieja
              // para que findActiveConversationOrgId() no la siga viendo activa.
              await clearConversation(user.id, organizationId!);
              // Cambio LOCAL a la conversación; no persistimos en DB.
              organizationId = orgMatch.org.id;
              effectiveOrgId = orgMatch.org.id;
              currentOrg = organizations.find(o => o.id === orgMatch.org.id) || currentOrg;

              const newAccounts = await storage.getAccountsByOrganization(orgMatch.org.id);
              const newConversation = await getOrCreateConversation(user.id, orgMatch.org.id);
              const newSuggestions = suggestAccounts(newAccounts, savedSlots.type, savedSlots.currency);
              const newAccountList = formatAccountSuggestions(newSuggestions);
              
              await updateConversation(user.id, orgMatch.org.id, {
                slots: {
                  type: savedSlots.type,
                  amount: savedSlots.amount,
                  currency: savedSlots.currency,
                  description: savedSlots.description,
                },
                currentStep: 'account',
                suggestedAccounts: newSuggestions.map(s => ({ id: s.account.id, name: s.account.name })),
              });
              
              const symbol = (savedSlots.currency === 'USD') ? 'U$D' : (savedSlots.currency === 'EUR') ? '€' : '$';
              const typeLabel = savedSlots.type === 'expense' ? 'gasto' : 
                               savedSlots.type === 'income' ? 'ingreso' :
                               savedSlots.type === 'receivable' ? 'cobro' : 'pago';
              
              await sendWhatsAppMessage(From, 
                `✅ ¡Cambiado a *${orgMatch.org.name}*!\n\n` +
                `Seguimos con tu ${typeLabel} de ${symbol}${savedSlots.amount?.toLocaleString('es-AR')} 👍\n\n` +
                `¿De qué cuenta?\n${newAccountList}\n\n` +
                `Respondé con el número o nombre de la cuenta`
              );
              return;
            }
          }
          
          // No org match found - show standard account reprompt
          const suggestions = suggestAccounts(accounts, conversation.slots.type, conversation.slots.currency);
          const accountList = formatAccountSuggestions(suggestions);
          await sendWhatsAppMessage(From, 
            `No entendí esa cuenta 🤔\n\n¿De qué cuenta salió/entró?\n${accountList}\n\nRespondé con el número (1, 2, 3) o el nombre de la cuenta`
          );
          return;
        }
      }

      // STEP: Description/detail input
      if (conversation.currentStep === 'description') {
        const editIntent = detectEditIntent(message);
        if (editIntent.field === 'cancel') {
          await resetConversation(user.id, organizationId!);
          await sendWhatsAppMessage(From, `👍 Cancelado. ¿En qué te puedo ayudar?`);
          return;
        }
        
        const hasMonetaryAmount = /\$\s*\d|\d[\d.,]*\s*(mil(?:l[oó]n(?:es)?)?|mill[oó]n(?:es)?|pesos|dolares|dólares|usd)\b/i.test(message) ||
          /\b\d[\d.,]*\s*(k|m)\b/i.test(message);
        const hasTransactionVerb = /(?:^|\s)(cobr[eéo]|pagu[eé]|gast[eéo]|ingres[eéo]|le\s+pagu[eé])(?:\s|$|[.,;:])/i.test(message);
        const looksLikeNewTransaction = hasMonetaryAmount && hasTransactionVerb;
        if (looksLikeNewTransaction) {
          console.log('[WhatsApp] New transaction detected during description step, resetting flow');
          await resetConversation(user.id, organizationId!);
        } else {
          const description = capitalizeFirst(message.trim());
          const slots = conversation.slots;
          
          let invoiceResolved = false;
          let smartResult: { category: string; hasInvoice: boolean; sources: SmartSlotSources } | null = null;
          try {
            const smart = await resolveSmartDefaults(
              user.id, organizationId!, slots.type!,
              description, null,
              slots.accountId || undefined, accounts
            );
            smartResult = smart;
            invoiceResolved = smart.sources.hasInvoice === 'pattern' || smart.sources.hasInvoice === 'preference' || smart.sources.hasInvoice === 'auto';
            const nextStep = invoiceResolved ? 'confirm' : 'invoice';
            await updateConversation(user.id, organizationId!, {
              slots: { 
                description,
                category: smart.category,
                categorySource: smart.sources.category || null,
                hasInvoice: smart.hasInvoice,
                invoiceSource: smart.sources.hasInvoice || null,
              },
              currentStep: nextStep
            });
          } catch (error) {
            invoiceResolved = true;
            smartResult = { category: 'General', hasInvoice: false, sources: { hasInvoice: 'auto', category: 'auto' } };
            await updateConversation(user.id, organizationId!, {
              slots: { description, hasInvoice: false, invoiceSource: 'auto' },
              currentStep: 'confirm'
            });
          }
          
          if (invoiceResolved && smartResult) {
            const invoiceLabel = buildInvoiceLabel(smartResult.hasInvoice, smartResult.sources.hasInvoice);
            const categoryLine = buildCategoryLabel(smartResult.category, smartResult.sources.category);
            const csLine = buildClientSupplierLine(slots.clientName || null, slots.supplierName || null);
            const typeLabels: Record<string, string> = { income: 'ingreso', expense: 'gasto', receivable: 'por cobrar', payable: 'por pagar' };
            const symbol = (slots.currency === 'USD') ? 'U$D' : (slots.currency === 'EUR') ? '€' : '$';
            const accountLine = slots.accountName ? `🏦 ${slots.accountName}\n` : '';
            await sendWhatsAppMessage(From, 
              `📍 *${currentOrg.name}*\n\n` +
              `Perfecto, te resumo:\n\n` +
              `💸 ${typeLabels[slots.type!] || 'movimiento'} de ${symbol}${(slots.amount || 0).toLocaleString('es-AR')} ${slots.currency || 'ARS'}\n` +
              accountLine +
              `📝 ${description}\n` +
              csLine +
              (categoryLine ? `${categoryLine}\n` : '') +
              `${invoiceLabel}\n\n` +
              `¿Confirmo? Respondé *sí* o *no* 😊`
            );
          } else {
            await sendWhatsAppMessage(From, 
              `✅ *${description}*\n\n🧾 ¿Tenés factura de esto? Respondé *sí* o *no*`
            );
          }
          return;
        }
      }

      // STEP: Category selection (legacy - no longer used, kept for backwards compatibility)
      if (conversation.currentStep === 'category') {
        const lowerMsg = message.toLowerCase().trim();
        
        // Check for cancel
        const editIntent = detectEditIntent(message);
        if (editIntent.field === 'cancel') {
          await resetConversation(user.id, organizationId!);
          await sendWhatsAppMessage(From, `👍 Cancelado. ¿En qué te puedo ayudar?`);
          return;
        }
        
        // Get available categories for this transaction type
        const categoryType = conversation.slots.type === 'income' || conversation.slots.type === 'receivable' 
          ? 'income' : 'expense';
        const categories = await storage.getTransactionCategoriesByOrganization(organizationId!, categoryType);
        
        // Try to match by number or name
        const availableCats = conversation.availableCategories || categories.map(c => ({ id: c.id, name: c.name }));
        const numChoice = parseInt(lowerMsg, 10);
        let selectedCategory: { id: string; name: string } | null = null;
        
        if (!isNaN(numChoice) && numChoice >= 1 && numChoice <= availableCats.length) {
          selectedCategory = availableCats[numChoice - 1];
        } else {
          // Try to match by name (fuzzy)
          selectedCategory = availableCats.find(c => 
            c.name.toLowerCase().includes(lowerMsg) || lowerMsg.includes(c.name.toLowerCase())
          ) || null;
        }
        
        if (selectedCategory) {
          // Task #379: si ya sabemos lo de la factura (caso: el usuario está
          // cambiando la categoría desde la confirmación), volvemos directo a
          // confirm con el resumen actualizado en vez de re-preguntar factura.
          const invoiceKnown = conversation.slots.hasInvoice !== null && conversation.slots.hasInvoice !== undefined;
          if (invoiceKnown) {
            await updateConversation(user.id, organizationId!, {
              slots: { category: selectedCategory.name, categorySource: 'explicit' },
              availableCategories: null,
              currentStep: 'confirm'
            });
            const slots = (await getOrCreateConversation(user.id, organizationId!)).slots;
            const typeLabels: Record<string, string> = {
              income: '💵 Ingreso',
              expense: '💸 Gasto',
              receivable: '📥 Por cobrar',
              payable: '📤 Por pagar'
            };
            const symbol = (slots.currency === 'USD') ? 'U$D' : (slots.currency === 'EUR') ? '€' : '$';
            const accountLine = slots.accountName ? buildAccountLabel(slots.accountName, slots.accountSource || undefined) + '\n' : '';
            const csLine = buildClientSupplierLine(slots.clientName || null, slots.supplierName || null);
            const categoryLine = buildCategoryLabel(selectedCategory.name, 'explicit');
            const invoiceLine = buildInvoiceLabel(slots.hasInvoice || false, slots.invoiceSource || undefined);
            await sendWhatsAppMessage(From,
              `✅ Categoría cambiada a *${selectedCategory.name}*\n\n` +
              `Te resumo:\n\n` +
              `${typeLabels[slots.type!]} de ${symbol}${slots.amount!.toLocaleString('es-AR')} ${slots.currency || 'ARS'}\n` +
              `📝 ${slots.description}\n` +
              accountLine +
              csLine +
              (categoryLine ? `${categoryLine}\n` : '') +
              `${invoiceLine}\n\n` +
              `¿Confirmo? Respondé *sí* o *no* 😊`
            );
            return;
          }
          await updateConversation(user.id, organizationId!, {
            slots: { category: selectedCategory.name, categorySource: 'explicit' },
            availableCategories: null,
            currentStep: 'invoice'
          });
          await sendWhatsAppMessage(From, 
            `✅ Categoría: *${selectedCategory.name}*\n\n🧾 ¿Tenés factura de esto? Respondé *sí* o *no*`
          );
          return;
        }
        
        // Invalid response - reprompt with list
        const categoryList = availableCats.map((c, i) => `${i + 1}️⃣ ${c.name}`).join('\n');
        await sendWhatsAppMessage(From, 
          `No entendí esa categoría 🤔\n\n¿Qué tipo de movimiento es?\n${categoryList}\n\nRespondé con el número o nombre`
        );
        return;
      }

      // STEP 1: Invoice question - yes/no
      // Ask if user has an invoice for this transaction
      if (conversation.currentStep === 'invoice') {
        const lowerMsg = message.toLowerCase().trim();
        
        // Check for edit intents first
        const editIntent = detectEditIntent(message);
        if (editIntent.field === 'cancel') {
          await resetConversation(user.id, organizationId!);
          await sendWhatsAppMessage(From, `👍 Cancelado. ¿En qué te puedo ayudar?`);
          return;
        }
        if (editIntent.field === 'amount') {
          await sendWhatsAppMessage(From, 
            `Para cambiar el monto, cancelá este movimiento con *cancelar* y empezá de nuevo indicando el nuevo monto.\n\n` +
            `O seguimos con el actual. ¿Tenés factura? Respondé *sí* o *no*`
          );
          return;
        }
        if (editIntent.field === 'type') {
          await sendWhatsAppMessage(From, 
            `Para cambiar el tipo de movimiento, cancelá con *cancelar* y empezá de nuevo.\n\n` +
            `O seguimos. ¿Tenés factura? Respondé *sí* o *no*`
          );
          return;
        }
        if (editIntent.field === 'account') {
          const suggestions = suggestAccounts(accounts, conversation.slots.type, conversation.slots.currency);
          const suggestedAccountsList = suggestions.map(s => ({ id: s.account.id, name: s.account.name }));
          const accountList = formatAccountSuggestions(suggestions);
          
          if (editIntent.value) {
            const matchedAccount = accounts.find(a => 
              a.name.toLowerCase().includes(editIntent.value!.toLowerCase())
            );
            if (matchedAccount) {
              await updateConversation(user.id, organizationId!, {
                slots: { accountId: matchedAccount.id, accountName: matchedAccount.name },
              });
              await sendWhatsAppMessage(From, 
                `✅ Cambiado a *${matchedAccount.name}*\n\n` +
                `🧾 ¿Tenés factura de esto? Respondé *sí* o *no*`
              );
              return;
            }
          }
          
          await updateConversation(user.id, organizationId!, {
            currentStep: 'account',
            suggestedAccounts: suggestedAccountsList
          });
          await sendWhatsAppMessage(From, 
            `¿A qué cuenta querés cambiar?\n\n${accountList}\n\n` +
            `Respondé con el número o nombre de la cuenta`
          );
          return;
        }
        
        const yesInvoice = ['si', 'sí', 'yes', 'tengo', 'claro', 'obvio', 'sep', 'sip'].includes(lowerMsg);
        const noInvoice = ['no', 'sin', 'sin factura', 'no tengo', 'nop', 'nope', 'na'].some(v => lowerMsg === v || lowerMsg.startsWith(v + ' '));
        
        if (yesInvoice) {
          // User has invoice - ask for invoice number
          await updateConversation(user.id, organizationId!, {
            slots: { hasInvoice: true },
            currentStep: 'invoice_number'
          });
          await sendWhatsAppMessage(From, 
            `Perfecto 📄\n\n` +
            `¿Cuál es el *número de factura*?\n\n` +
            `(Si no lo tenés a mano, escribí *omitir*)`
          );
          return;
        }
        
        if (noInvoice) {
          // No invoice - go to confirm
          await updateConversation(user.id, organizationId!, {
            slots: { hasInvoice: false },
            currentStep: 'confirm'
          });
          
          const slots = (await getOrCreateConversation(user.id, organizationId!)).slots;
          const typeLabels: Record<string, string> = {
            income: '💵 Ingreso',
            expense: '💸 Gasto',
            receivable: '📥 Por cobrar',
            payable: '📤 Por pagar'
          };
          const symbol = (slots.currency === 'USD') ? 'U$D' : (slots.currency === 'EUR') ? '€' : '$';
          const accountLine = slots.accountName ? buildAccountLabel(slots.accountName, slots.accountSource || undefined) + '\n' : '';
          const categoryLine = buildCategoryLabel(slots.category || 'General', slots.categorySource || undefined);
          
          await sendWhatsAppMessage(From, 
            `Perfecto, te resumo:\n\n` +
            `${typeLabels[slots.type!]} de ${symbol}${slots.amount!.toLocaleString('es-AR')} ${slots.currency || 'ARS'}\n` +
            `📝 ${slots.description}\n` +
            accountLine +
            (categoryLine ? `${categoryLine}\n` : '') +
            `📄 Sin factura\n\n` +
            `¿Confirmo? Respondé *sí* o *no* 😊`
          );
          return;
        }
        
        // Unclear response - reprompt
        await sendWhatsAppMessage(From, 
          `🧾 ¿Tenés factura de esto?\n\nRespondé *sí* o *no*`
        );
        return;
      }

      // STEP 2: Invoice number
      if (conversation.currentStep === 'invoice_number') {
        const lowerMsg = message.toLowerCase().trim();
        const skipNumber = ['omitir', 'skip', 'no tengo', 'no se', 'no sé', 'despues', 'después'].some(v => lowerMsg === v || lowerMsg.startsWith(v + ' '));
        
        // Check for cancel
        const editIntent = detectEditIntent(message);
        if (editIntent.field === 'cancel') {
          await resetConversation(user.id, organizationId!);
          await sendWhatsAppMessage(From, `👍 Cancelado. ¿En qué te puedo ayudar?`);
          return;
        }
        
        if (skipNumber) {
          // Skip invoice number - mark as skipped and ask about image
          await updateConversation(user.id, organizationId!, {
            slots: { hasInvoice: true, invoiceNumber: 'skipped' },
            currentStep: 'invoice_image'
          });
          await sendWhatsAppMessage(From, 
            `👍 Sin problema.\n\n` +
            `¿Querés adjuntar una *foto o archivo* de la factura?\n\n` +
            `• Enviá la *imagen/PDF*\n` +
            `• O respondé *no* para continuar sin adjunto`
          );
          return;
        }
        
        // Save the invoice number (ensure hasInvoice is set)
        if (message.trim().length > 0 && message.trim().length <= 50) {
          await updateConversation(user.id, organizationId!, {
            slots: { hasInvoice: true, invoiceNumber: message.trim() },
            currentStep: 'invoice_image'
          });
          await sendWhatsAppMessage(From, 
            `✅ Número de factura: *${message.trim()}*\n\n` +
            `¿Querés adjuntar una *foto o archivo* de la factura?\n\n` +
            `• Enviá la *imagen/PDF*\n` +
            `• O respondé *no* para continuar sin adjunto`
          );
          return;
        }
        
        // Invalid input
        await sendWhatsAppMessage(From, 
          `¿Cuál es el número de factura?\n\n` +
          `(Escribí el número o *omitir* si no lo tenés)`
        );
        return;
      }

      // STEP 3: Invoice image/file attachment
      if (conversation.currentStep === 'invoice_image') {
        const lowerMsg = message.toLowerCase().trim();
        const mediaUrl = req.body.MediaUrl0;
        const skipImage = ['no', 'sin', 'omitir', 'skip', 'continuar', 'seguir', 'listo'].some(v => lowerMsg === v || lowerMsg.startsWith(v + ' '));
        
        // Check for cancel
        const editIntent = detectEditIntent(message);
        if (editIntent.field === 'cancel') {
          await resetConversation(user.id, organizationId!);
          await sendWhatsAppMessage(From, `👍 Cancelado. ¿En qué te puedo ayudar?`);
          return;
        }
        
        // User sent an image/file
        if (mediaUrl) {
          let imageUploadFailed = false;
          try {
            console.log('[WhatsApp] Saving invoice image from:', mediaUrl);
            const imageUrl = await saveWhatsAppImageToStorage(mediaUrl, organizationId!, user.id);
            console.log('[WhatsApp] Image saved successfully:', imageUrl);
            await updateConversation(user.id, organizationId!, {
              slots: { hasInvoice: true, invoiceFileUrl: imageUrl },
              currentStep: 'confirm'
            });
          } catch (err) {
            console.error('[WhatsApp] Error saving invoice image:', err);
            imageUploadFailed = true;
            await updateConversation(user.id, organizationId!, {
              slots: { hasInvoice: true, invoiceFileUrl: '' },
              currentStep: 'confirm'
            });
          }
          
          // Show confirmation summary
          const slots = (await getOrCreateConversation(user.id, organizationId!)).slots;
          const typeLabels: Record<string, string> = {
            income: '💵 Ingreso',
            expense: '💸 Gasto',
            receivable: '📥 Por cobrar',
            payable: '📤 Por pagar'
          };
          const symbol = (slots.currency === 'USD') ? 'U$D' : (slots.currency === 'EUR') ? '€' : '$';
          const accountLine = slots.accountName ? buildAccountLabel(slots.accountName, slots.accountSource || undefined) + '\n' : '';
          const categoryLine = buildCategoryLabel(slots.category || 'General', slots.categorySource || undefined);
          const invoiceNumLine = slots.invoiceNumber && slots.invoiceNumber !== 'skipped' ? `📝 Nº Factura: ${slots.invoiceNumber}\n` : '';
          const imageLine = slots.invoiceFileUrl && slots.invoiceFileUrl !== 'skipped' ? '📎 Con imagen adjunta\n' : '';
          const errorPrefix = imageUploadFailed ? '⚠️ No pude guardar la foto, pero continúo sin ella.\n\n' : '';
          const imgCsLine = buildClientSupplierLine(slots.clientName, slots.supplierName);
          
          await sendWhatsAppMessage(From, 
            errorPrefix +
            `Perfecto, te resumo:\n\n` +
            `${typeLabels[slots.type!]} de ${symbol}${slots.amount!.toLocaleString('es-AR')} ${slots.currency || 'ARS'}\n` +
            `📝 ${slots.description}\n` +
            accountLine +
            imgCsLine +
            (categoryLine ? `${categoryLine}\n` : '') +
            `🧾 Con factura\n` +
            invoiceNumLine +
            imageLine +
            `\n¿Confirmo? Respondé *sí* o *no* 😊`
          );
          return;
        }
        
        // User doesn't want to attach image - mark as skipped
        if (skipImage) {
          await updateConversation(user.id, organizationId!, {
            slots: { hasInvoice: true, invoiceFileUrl: 'skipped' },
            currentStep: 'confirm'
          });
          
          const slots = (await getOrCreateConversation(user.id, organizationId!)).slots;
          const typeLabels: Record<string, string> = {
            income: '💵 Ingreso',
            expense: '💸 Gasto',
            receivable: '📥 Por cobrar',
            payable: '📤 Por pagar'
          };
          const symbol = (slots.currency === 'USD') ? 'U$D' : (slots.currency === 'EUR') ? '€' : '$';
          const accountLine = slots.accountName ? buildAccountLabel(slots.accountName, slots.accountSource || undefined) + '\n' : '';
          const categoryLine = buildCategoryLabel(slots.category || 'General', slots.categorySource || undefined);
          const invoiceNumLine = slots.invoiceNumber && slots.invoiceNumber !== 'skipped' ? `📝 Nº Factura: ${slots.invoiceNumber}\n` : '';
          const invoiceCsLine = buildClientSupplierLine(slots.clientName, slots.supplierName);
          
          await sendWhatsAppMessage(From, 
            `Perfecto, te resumo:\n\n` +
            `${typeLabels[slots.type!]} de ${symbol}${slots.amount!.toLocaleString('es-AR')} ${slots.currency || 'ARS'}\n` +
            `📝 ${slots.description}\n` +
            accountLine +
            invoiceCsLine +
            (categoryLine ? `${categoryLine}\n` : '') +
            `🧾 Con factura\n` +
            invoiceNumLine +
            `\n¿Confirmo? Respondé *sí* o *no* 😊`
          );
          return;
        }
        
        // Unclear - reprompt
        await sendWhatsAppMessage(From, 
          `📎 ¿Querés adjuntar la factura?\n\n` +
          `• Enviá una *foto* o *PDF*\n` +
          `• O respondé *no* para continuar sin adjunto`
        );
        return;
      }

      // Extract transaction intent from message
      const extractedSlots = await extractTransactionSlots(message);
      console.log(`[WhatsApp] Extracted slots:`, extractedSlots);
      
      const resolvedCS = (extractedSlots.clientName || extractedSlots.supplierName)
        ? await resolveClientSupplier(organizationId!, extractedSlots)
        : { clientId: null, clientName: null, supplierId: null, supplierName: null, notFoundMessages: [] as string[] };
      
      if (resolvedCS.notFoundMessages.length > 0) {
        for (const nfMsg of resolvedCS.notFoundMessages) {
          await sendWhatsAppMessage(From, nfMsg);
        }
      }

      // If we detected a transaction intent, start/continue the flow
      if (extractedSlots && extractedSlots.type && extractedSlots.amount) {
        const typeLabels: Record<string, string> = {
          income: 'ingreso',
          expense: 'gasto',
          receivable: 'por cobrar',
          payable: 'por pagar'
        };
        
        // Check if there are accounts matching the detected currency
        const detectedCurrency = extractedSlots.currency || 'ARS';
        const currencyExplicit = extractedSlots.currencyExplicit === true;
        const accountsInCurrency = accounts.filter(acc => {
          const accCurrency = (acc.currency || 'ARS').toUpperCase();
          const targetCurrency = detectedCurrency.toUpperCase();
          if (targetCurrency === 'USD' || targetCurrency === 'USD_CASH') {
            return accCurrency === 'USD' || accCurrency === 'USD_CASH';
          }
          return accCurrency === targetCurrency;
        });
        
        // If user explicitly mentioned foreign currency but no accounts in that currency, BLOCK and ask to create account
        if (currencyExplicit && (detectedCurrency === 'USD' || detectedCurrency === 'EUR') && accountsInCurrency.length === 0) {
          const currencyName = detectedCurrency === 'USD' ? 'dólares' : 'euros';
          await sendWhatsAppMessage(From, 
            `📍 *${currentOrg.name}*\n\n` +
            `⚠️ No tenés cuentas en ${currencyName} en esta organización.\n\n` +
            `Para registrar movimientos en ${currencyName}, primero tenés que crear una cuenta en esa moneda.\n\n` +
            `👉 Entrá a *aikestar.net* → Cuentas → Nueva cuenta → Elegí ${detectedCurrency} como moneda`
          );
          return;
        }
        
        // Check if user has accounts in multiple currencies and currency was not explicit
        // If so, ask for clarification
        const accountCurrencies = new Set(accounts.map(acc => {
          const curr = (acc.currency || 'ARS').toUpperCase();
          return curr === 'USD_CASH' ? 'USD' : curr;
        }));
        const hasMultipleCurrencies = accountCurrencies.size > 1;
        const hasUSD = accountCurrencies.has('USD');
        const hasARS = accountCurrencies.has('ARS');
        
        if (!currencyExplicit && hasMultipleCurrencies && hasUSD && hasARS) {
          // Smart default: assume ARS when currency not mentioned (most common for Argentine users)
          // This avoids an extra question step
          console.log('[WhatsApp] Currency not explicit, defaulting to ARS');
        }
        
        const finalCurrency = detectedCurrency;
        const symbol = (finalCurrency === 'USD') ? 'U$D' : (finalCurrency === 'EUR') ? '€' : '$';
        
        // receivable/payable don't require an account - go to category step
        const needsAccount = extractedSlots.type === 'income' || extractedSlots.type === 'expense';
        
        if (!needsAccount) {
          const composedDesc = composeDescription(extractedSlots.description, extractedSlots.type, resolvedCS.clientName, resolvedCS.supplierName);
          const hasDescription = composedDesc && !isGenericDescription(composedDesc);
          const wantsAutoConfirm = extractedSlots.autoConfirm === true;
          
          const smart = await resolveSmartDefaults(
            user.id, organizationId!, extractedSlots.type!, 
            extractedSlots.description, extractedSlots.hasInvoice
          );
          
          let nextStep: ConversationState['currentStep'];
          if (!hasDescription) {
            nextStep = 'description';
          } else {
            nextStep = 'confirm';
          }
          
          await updateConversation(user.id, organizationId!, {
            slots: {
              type: extractedSlots.type,
              amount: extractedSlots.amount,
              currency: finalCurrency,
              description: hasDescription ? capitalizeFirst(composedDesc) : null,
              category: smart.category,
              hasInvoice: smart.hasInvoice,
              categorySource: smart.sources.category || null,
              invoiceSource: smart.sources.hasInvoice || null,
              clientId: resolvedCS.clientId,
              clientName: resolvedCS.clientName,
              supplierId: resolvedCS.supplierId,
              supplierName: resolvedCS.supplierName,
            },
            currentStep: nextStep
          });
          
          const csLine = buildClientSupplierLine(resolvedCS.clientName, resolvedCS.supplierName);
          
          if (nextStep === 'confirm' && wantsAutoConfirm && !hasInferredDefaults(smart.sources)) {
            const now = new Date();
            const isCompleted = extractedSlots.type === 'income' || extractedSlots.type === 'expense';
            await createWhatsAppTransaction({
              organizationId: organizationId!,
              accountId: null,
              type: extractedSlots.type!,
              amount: String(extractedSlots.amount),
              currency: finalCurrency,
              description: capitalizeFirst(composedDesc || 'Movimiento por WhatsApp'),
              category: smart.category,
              date: argentinaTodayAtNoon(),
              imputationDate: argentinaTodayAtNoon(),
              status: isCompleted ? 'completed' : 'scheduled',
              createdBy: user.id,
              completedBy: isCompleted ? user.id : null,
              completedAt: isCompleted ? now : null,
              hasInvoice: smart.hasInvoice,
              invoiceType: null,
              invoiceNumber: null,
              invoiceTaxId: null,
              invoiceFileUrl: null,
              createdVia: 'whatsapp',
              clientId: resolvedCS.clientId,
              supplierId: resolvedCS.supplierId,
            }, user.id);
            const invoiceLabel = smart.hasInvoice ? '🧾 Con factura' : '📄 Sin factura';
            const categoryLine = buildCategoryLabel(smart.category, smart.sources.category);
            await resetConversation(user.id, organizationId!);
            await updateConversation(user.id, organizationId!, { justCompletedTransaction: true });
            await sendWhatsAppMessage(From, 
              `✅ ¡Listo! Registrado en *${currentOrg.name}*\n\n` +
              `${typeLabels[extractedSlots.type!]}: ${symbol}${extractedSlots.amount!.toLocaleString('es-AR')} ${finalCurrency}\n` +
              `📝 ${capitalizeFirst(composedDesc || extractedSlots.description || 'Movimiento')}\n` +
              csLine +
              (categoryLine ? `${categoryLine}\n` : '') +
              `${invoiceLabel}\n\n` +
              `¿Querés registrar otro movimiento? 😊`
            );
          } else if (nextStep === 'confirm') {
            const invoiceLabel = buildInvoiceLabel(smart.hasInvoice, smart.sources.hasInvoice);
            const categoryLine = buildCategoryLabel(smart.category, smart.sources.category);
            await sendWhatsAppMessage(From, 
              `📍 *${currentOrg.name}*\n\n` +
              `Perfecto, te resumo:\n\n` +
              `${typeLabels[extractedSlots.type!]} de ${symbol}${extractedSlots.amount!.toLocaleString('es-AR')} ${finalCurrency}\n` +
              `📝 ${capitalizeFirst(composedDesc || extractedSlots.description || 'Movimiento')}\n` +
              csLine +
              (categoryLine ? `${categoryLine}\n` : '') +
              `${invoiceLabel}\n\n` +
              `¿Confirmo? Respondé *sí* o *no* 😊`
            );
          } else {
            await sendWhatsAppMessage(From, 
              `📍 *${currentOrg.name}*\n\n` +
              `¡Perfecto! ${symbol}${extractedSlots.amount.toLocaleString('es-AR')} ${typeLabels[extractedSlots.type]} 📝\n\n` +
              `📝 ¿Cuál es el detalle de este movimiento?`
            );
          }
          return;
        }

        // income/expense - need to select account
        // If only one account, auto-select — BUT respect explicit currency
        if (accounts.length === 1) {
          const accountCurrency = (accounts[0].currency || 'ARS').toUpperCase();
          const normalizedDetected = detectedCurrency.toUpperCase();
          const currencyMatch = (normalizedDetected === 'USD' || normalizedDetected === 'USD_CASH')
            ? (accountCurrency === 'USD' || accountCurrency === 'USD_CASH')
            : accountCurrency === normalizedDetected;
          
          if (currencyExplicit && !currencyMatch) {
            const currencyName = normalizedDetected === 'USD' ? 'dólares' : normalizedDetected === 'EUR' ? 'euros' : 'pesos';
            await sendWhatsAppMessage(From, 
              `📍 *${currentOrg.name}*\n\n` +
              `⚠️ Mencionaste *${currencyName}* pero tu única cuenta (*${accounts[0].name}*) es en *${accountCurrency === 'USD' || accountCurrency === 'USD_CASH' ? 'dólares' : accountCurrency === 'EUR' ? 'euros' : 'pesos'}*.\n\n` +
              `Para registrar movimientos en ${currencyName}, primero creá una cuenta en esa moneda.\n\n` +
              `👉 Entrá a *aikestar.net* → Cuentas → Nueva cuenta → Elegí ${normalizedDetected} como moneda`
            );
            return;
          }
          
          const accountSymbol = (accountCurrency === 'USD' || accountCurrency === 'USD_CASH') ? 'U$D' : (accountCurrency === 'EUR') ? '€' : '$';
          const composedDesc1 = composeDescription(extractedSlots.description, extractedSlots.type, resolvedCS.clientName, resolvedCS.supplierName);
          const hasDescription = composedDesc1 && !isGenericDescription(composedDesc1);
          
          const smart = await resolveSmartDefaults(
            user.id, organizationId!, extractedSlots.type!, 
            extractedSlots.description, extractedSlots.hasInvoice,
            accounts[0].id, accounts
          );
          
          let nextStep: ConversationState['currentStep'];
          if (!hasDescription) {
            nextStep = 'description';
          } else {
            nextStep = 'confirm';
          }
          
          await updateConversation(user.id, organizationId!, {
            slots: {
              type: extractedSlots.type,
              amount: extractedSlots.amount,
              currency: accountCurrency,
              description: hasDescription ? capitalizeFirst(composedDesc1) : null,
              accountId: accounts[0].id, 
              accountName: accounts[0].name,
              accountSource: 'auto',
              category: smart.category,
              hasInvoice: smart.hasInvoice,
              categorySource: smart.sources.category || null,
              invoiceSource: smart.sources.hasInvoice || null,
              clientId: resolvedCS.clientId,
              clientName: resolvedCS.clientName,
              supplierId: resolvedCS.supplierId,
              supplierName: resolvedCS.supplierName,
            },
            currentStep: nextStep
          });
          
          const csLine1 = buildClientSupplierLine(resolvedCS.clientName, resolvedCS.supplierName);
          
          if (nextStep === 'confirm' && extractedSlots.autoConfirm && !hasInferredDefaults(smart.sources)) {
            const now = new Date();
            const isCompleted = extractedSlots.type === 'income' || extractedSlots.type === 'expense';
            await createWhatsAppTransaction({
              organizationId: organizationId!,
              accountId: accounts[0].id,
              type: extractedSlots.type!,
              amount: String(extractedSlots.amount),
              currency: accountCurrency,
              description: capitalizeFirst(composedDesc1 || 'Movimiento por WhatsApp'),
              category: smart.category,
              date: argentinaTodayAtNoon(),
              imputationDate: argentinaTodayAtNoon(),
              status: isCompleted ? 'completed' : 'scheduled',
              createdBy: user.id,
              completedBy: isCompleted ? user.id : null,
              completedAt: isCompleted ? now : null,
              hasInvoice: smart.hasInvoice,
              invoiceType: null,
              invoiceNumber: null,
              invoiceTaxId: null,
              invoiceFileUrl: null,
              createdVia: 'whatsapp',
              clientId: resolvedCS.clientId,
              supplierId: resolvedCS.supplierId,
            }, user.id);
            const invoiceLabel = smart.hasInvoice ? '🧾 Con factura' : '📄 Sin factura';
            const categoryLine = buildCategoryLabel(smart.category, smart.sources.category);
            await resetConversation(user.id, organizationId!);
            await updateConversation(user.id, organizationId!, { justCompletedTransaction: true });
            await sendWhatsAppMessage(From, 
              `✅ ¡Listo! Registrado en *${currentOrg.name}*\n\n` +
              `💸 ${typeLabels[extractedSlots.type!]}: ${accountSymbol}${extractedSlots.amount!.toLocaleString('es-AR')} ${accountCurrency}\n` +
              `🏦 ${accounts[0].name}\n` +
              `📝 ${capitalizeFirst(composedDesc1 || extractedSlots.description || 'Movimiento')}\n` +
              csLine1 +
              (categoryLine ? `${categoryLine}\n` : '') +
              `${invoiceLabel}\n\n` +
              `¿Querés registrar otro movimiento? 😊`
            );
          } else if (nextStep === 'confirm') {
            const invoiceLabel = buildInvoiceLabel(smart.hasInvoice, smart.sources.hasInvoice);
            const categoryLine = buildCategoryLabel(smart.category, smart.sources.category);
            await sendWhatsAppMessage(From, 
              `📍 *${currentOrg.name}*\n\n` +
              `Perfecto, te resumo:\n\n` +
              `💸 ${typeLabels[extractedSlots.type!]} de ${accountSymbol}${extractedSlots.amount!.toLocaleString('es-AR')} ${accountCurrency}\n` +
              `🏦 ${accounts[0].name}\n` +
              `📝 ${capitalizeFirst(composedDesc1 || extractedSlots.description || 'Movimiento')}\n` +
              csLine1 +
              (categoryLine ? `${categoryLine}\n` : '') +
              `${invoiceLabel}\n\n` +
              `¿Confirmo? Respondé *sí* o *no* 😊`
            );
          } else {
            await sendWhatsAppMessage(From, 
              `📍 *${currentOrg.name}*\n\n` +
              `¡Perfecto! ${accountSymbol}${extractedSlots.amount.toLocaleString('es-AR')} de ${typeLabels[extractedSlots.type]} 💸\n\n` +
              `Lo anoto en *${accounts[0].name}*.\n\n` +
              `📝 ¿Cuál es el detalle de este movimiento?`
            );
          }
        } else if (accounts.length === 0) {
          // No accounts - can't proceed
          await sendWhatsAppMessage(From, 
            `⚠️ No tenés cuentas configuradas en *${currentOrg.name}*.\n\n` +
            `Entrá a aikestar.net y creá una cuenta primero para poder registrar movimientos.`
          );
        } else {
          // Multiple accounts - check if only one matches the currency
          const accountsInCurrency = accounts.filter(acc => {
            const accCurrency = (acc.currency || 'ARS').toUpperCase();
            if (finalCurrency === 'USD') {
              return accCurrency === 'USD' || accCurrency === 'USD_CASH';
            }
            return accCurrency === finalCurrency;
          });
          
          // If only one account in that currency, auto-select it
          if (accountsInCurrency.length === 1) {
            const composedDesc2 = composeDescription(extractedSlots.description, extractedSlots.type, resolvedCS.clientName, resolvedCS.supplierName);
            const hasDescription = composedDesc2 && !isGenericDescription(composedDesc2);
            const currencyLabel = finalCurrency === 'USD' ? 'dólares' : finalCurrency === 'EUR' ? 'euros' : 'pesos';
            
            const smart = await resolveSmartDefaults(
              user.id, organizationId!, extractedSlots.type!, 
              extractedSlots.description, extractedSlots.hasInvoice,
              accountsInCurrency[0].id, accounts
            );
            
            let nextStep: ConversationState['currentStep'];
            if (!hasDescription) {
              nextStep = 'description';
            } else {
              nextStep = 'confirm';
            }
            
            await updateConversation(user.id, organizationId!, {
              slots: {
                type: extractedSlots.type,
                amount: extractedSlots.amount,
                currency: finalCurrency,
                description: hasDescription ? capitalizeFirst(composedDesc2) : null,
                accountId: accountsInCurrency[0].id, 
                accountName: accountsInCurrency[0].name,
                accountSource: 'auto',
                category: smart.category,
                hasInvoice: smart.hasInvoice,
                categorySource: smart.sources.category || null,
                invoiceSource: smart.sources.hasInvoice || null,
                clientId: resolvedCS.clientId,
                clientName: resolvedCS.clientName,
                supplierId: resolvedCS.supplierId,
                supplierName: resolvedCS.supplierName,
              },
              currentStep: nextStep
            });
            
            const csLine2 = buildClientSupplierLine(resolvedCS.clientName, resolvedCS.supplierName);
            
            if (nextStep === 'confirm' && extractedSlots.autoConfirm && !hasInferredDefaults(smart.sources)) {
              const now = new Date();
              const isCompleted = extractedSlots.type === 'income' || extractedSlots.type === 'expense';
              await createWhatsAppTransaction({
                organizationId: organizationId!,
                accountId: accountsInCurrency[0].id,
                type: extractedSlots.type!,
                amount: String(extractedSlots.amount),
                currency: finalCurrency,
                description: capitalizeFirst(composedDesc2 || 'Movimiento por WhatsApp'),
                category: smart.category,
                date: argentinaTodayAtNoon(),
                imputationDate: argentinaTodayAtNoon(),
                status: isCompleted ? 'completed' : 'scheduled',
                createdBy: user.id,
                completedBy: isCompleted ? user.id : null,
                completedAt: isCompleted ? now : null,
                hasInvoice: smart.hasInvoice,
                invoiceType: null,
                invoiceNumber: null,
                invoiceTaxId: null,
                invoiceFileUrl: null,
                createdVia: 'whatsapp',
                clientId: resolvedCS.clientId,
                supplierId: resolvedCS.supplierId,
              }, user.id);
              const invoiceLabel = smart.hasInvoice ? '🧾 Con factura' : '📄 Sin factura';
              const categoryLine = buildCategoryLabel(smart.category, smart.sources.category);
              await resetConversation(user.id, organizationId!);
              await updateConversation(user.id, organizationId!, { justCompletedTransaction: true });
              await sendWhatsAppMessage(From, 
                `✅ ¡Listo! Registrado en *${currentOrg.name}*\n\n` +
                `💸 ${typeLabels[extractedSlots.type!]}: ${symbol}${extractedSlots.amount!.toLocaleString('es-AR')} ${finalCurrency}\n` +
                `🏦 ${accountsInCurrency[0].name}\n` +
                `📝 ${capitalizeFirst(composedDesc2 || extractedSlots.description || 'Movimiento')}\n` +
                csLine2 +
                (categoryLine ? `${categoryLine}\n` : '') +
                `${invoiceLabel}\n\n` +
                `¿Querés registrar otro movimiento? 😊`
              );
            } else if (nextStep === 'confirm') {
              const invoiceLabel = buildInvoiceLabel(smart.hasInvoice, smart.sources.hasInvoice);
              const categoryLine = buildCategoryLabel(smart.category, smart.sources.category);
              await sendWhatsAppMessage(From, 
                `📍 *${currentOrg.name}*\n\n` +
                `Perfecto, te resumo:\n\n` +
                `💸 ${typeLabels[extractedSlots.type!]} de ${symbol}${extractedSlots.amount!.toLocaleString('es-AR')} ${finalCurrency}\n` +
                `🏦 ${accountsInCurrency[0].name}\n` +
                `📝 ${capitalizeFirst(composedDesc2 || extractedSlots.description || 'Movimiento')}\n` +
                csLine2 +
                (categoryLine ? `${categoryLine}\n` : '') +
                `${invoiceLabel}\n\n` +
                `¿Confirmo? Respondé *sí* o *no* 😊`
              );
            } else {
              await sendWhatsAppMessage(From, 
                `📍 *${currentOrg.name}*\n\n` +
                `¡Dale! ${symbol}${extractedSlots.amount.toLocaleString('es-AR')} de ${typeLabels[extractedSlots.type]} 💸\n\n` +
                `🏦 Tenés solo *${accountsInCurrency[0].name}* en ${currencyLabel}, lo anoto ahí.\n\n` +
                `📝 ¿Cuál es el detalle de este movimiento?`
              );
            }
            return;
          }
          
          // Multiple accounts in currency - use smart defaults (pattern/preference) to select, or ask user
          const smart = await resolveSmartDefaults(
            user.id, organizationId!, extractedSlots.type!, 
            extractedSlots.description, extractedSlots.hasInvoice,
            null, accounts
          );
          
          let bestAccount: { id: string; name: string; currency?: string | null } | null = null;
          let accountSource = smart.sources.account;
          
          if (smart.accountId && smart.accountName && (accountSource === 'preference' || accountSource === 'pattern')) {
            const smartAccountInCurrency = accountsInCurrency.find(a => a.id === smart.accountId);
            if (smartAccountInCurrency) {
              bestAccount = smartAccountInCurrency;
            }
          }
          
          if (!bestAccount && accountsInCurrency.length === 2) {
            const balances = accountsInCurrency.map(a => parseFloat(a.balance || '0'));
            const maxBal = Math.max(...balances);
            const minBal = Math.min(...balances);
            if (maxBal > 0 && (minBal <= 0 || maxBal >= minBal * 3)) {
              const topIdx = balances.indexOf(maxBal);
              bestAccount = accountsInCurrency[topIdx];
              accountSource = 'auto';
              console.log(`[WhatsApp] Auto-selecting dominant-balance account for ${finalCurrency}: ${bestAccount.name}`);
            }
          }
          
          if (!bestAccount) {
            const composedDesc3 = composeDescription(extractedSlots.description, extractedSlots.type, resolvedCS.clientName, resolvedCS.supplierName);
            const hasDescription = composedDesc3 && !isGenericDescription(composedDesc3);
            const fallbackSuggestions = suggestAccounts(accountsInCurrency, extractedSlots.type, finalCurrency);
            const accountList = formatAccountSuggestions(fallbackSuggestions);
            
            await updateConversation(user.id, organizationId!, {
              slots: {
                type: extractedSlots.type,
                amount: extractedSlots.amount,
                currency: finalCurrency,
                description: hasDescription ? capitalizeFirst(composedDesc3) : null,
                category: smart.category,
                hasInvoice: smart.hasInvoice,
                categorySource: smart.sources.category || null,
                invoiceSource: smart.sources.hasInvoice || null,
                clientId: resolvedCS.clientId,
                clientName: resolvedCS.clientName,
                supplierId: resolvedCS.supplierId,
                supplierName: resolvedCS.supplierName,
              },
              currentStep: 'account',
              suggestedAccounts: fallbackSuggestions.map(s => ({ id: s.account.id, name: s.account.name }))
            });
            
            await sendWhatsAppMessage(From, 
              `📍 *${currentOrg.name}*\n\n` +
              `${typeLabels[extractedSlots.type!]} de ${symbol}${extractedSlots.amount!.toLocaleString('es-AR')} ${finalCurrency}\n\n` +
              `🏦 ¿De qué cuenta?\n${accountList}\n\n` +
              `Respondé con el número o nombre de la cuenta`
            );
            return;
          }
          
          const bestAccountCurrency = (bestAccount.currency || 'ARS').toUpperCase();
          const bestSymbol = (bestAccountCurrency === 'USD' || bestAccountCurrency === 'USD_CASH') ? 'U$D' : (bestAccountCurrency === 'EUR') ? '€' : '$';
          
          const composedDesc4 = composeDescription(extractedSlots.description, extractedSlots.type, resolvedCS.clientName, resolvedCS.supplierName);
          const hasDescription = composedDesc4 && !isGenericDescription(composedDesc4);
          
          let nextStep: ConversationState['currentStep'];
          if (!hasDescription) {
            nextStep = 'description';
          } else {
            nextStep = 'confirm';
          }
          
          await updateConversation(user.id, organizationId!, {
            slots: {
              type: extractedSlots.type,
              amount: extractedSlots.amount,
              currency: finalCurrency,
              description: hasDescription ? capitalizeFirst(composedDesc4) : null,
              accountId: bestAccount.id,
              accountName: bestAccount.name,
              accountSource: accountSource || 'auto',
              category: smart.category,
              hasInvoice: smart.hasInvoice,
              categorySource: smart.sources.category || null,
              invoiceSource: smart.sources.hasInvoice || null,
              clientId: resolvedCS.clientId,
              clientName: resolvedCS.clientName,
              supplierId: resolvedCS.supplierId,
              supplierName: resolvedCS.supplierName,
            },
            currentStep: nextStep
          });
          
          const csLine3 = buildClientSupplierLine(resolvedCS.clientName, resolvedCS.supplierName);
          
          if (nextStep === 'confirm' && extractedSlots.autoConfirm && !hasInferredDefaults(smart.sources)) {
            const now = new Date();
            const isCompleted = extractedSlots.type === 'income' || extractedSlots.type === 'expense';
            await createWhatsAppTransaction({
              organizationId: organizationId!,
              accountId: bestAccount.id,
              type: extractedSlots.type!,
              amount: String(extractedSlots.amount),
              currency: finalCurrency,
              description: capitalizeFirst(composedDesc4 || 'Movimiento por WhatsApp'),
              category: smart.category,
              date: argentinaTodayAtNoon(),
              imputationDate: argentinaTodayAtNoon(),
              status: isCompleted ? 'completed' : 'scheduled',
              createdBy: user.id,
              completedBy: isCompleted ? user.id : null,
              completedAt: isCompleted ? now : null,
              hasInvoice: smart.hasInvoice,
              invoiceType: null,
              invoiceNumber: null,
              invoiceTaxId: null,
              invoiceFileUrl: null,
              createdVia: 'whatsapp',
              clientId: resolvedCS.clientId,
              supplierId: resolvedCS.supplierId,
            }, user.id);
            const invoiceLabel = smart.hasInvoice ? '🧾 Con factura' : '📄 Sin factura';
            const categoryLine = buildCategoryLabel(smart.category, smart.sources.category);
            await resetConversation(user.id, organizationId!);
            await updateConversation(user.id, organizationId!, { justCompletedTransaction: true });
            await sendWhatsAppMessage(From, 
              `✅ ¡Listo! Registrado en *${currentOrg.name}*\n\n` +
              `💸 ${typeLabels[extractedSlots.type!]}: ${bestSymbol}${extractedSlots.amount!.toLocaleString('es-AR')} ${finalCurrency}\n` +
              `${buildAccountLabel(bestAccount.name, accountSource)}\n` +
              `📝 ${capitalizeFirst(composedDesc4 || extractedSlots.description || 'Movimiento')}\n` +
              csLine3 +
              (categoryLine ? `${categoryLine}\n` : '') +
              `${invoiceLabel}\n\n` +
              `¿Querés registrar otro movimiento? 😊`
            );
          } else if (nextStep === 'confirm') {
            const invoiceLabel = buildInvoiceLabel(smart.hasInvoice, smart.sources.hasInvoice);
            const categoryLine = buildCategoryLabel(smart.category, smart.sources.category);
            await sendWhatsAppMessage(From, 
              `📍 *${currentOrg.name}*\n\n` +
              `Perfecto, te resumo:\n\n` +
              `💸 ${typeLabels[extractedSlots.type!]} de ${bestSymbol}${extractedSlots.amount!.toLocaleString('es-AR')} ${finalCurrency}\n` +
              `${buildAccountLabel(bestAccount.name, accountSource)}\n` +
              `📝 ${capitalizeFirst(composedDesc4 || extractedSlots.description || 'Movimiento')}\n` +
              csLine3 +
              (categoryLine ? `${categoryLine}\n` : '') +
              `${invoiceLabel}\n\n` +
              `¿Confirmo? Respondé *sí* o *no*\n` +
              `💡 _Podés cambiar la cuenta diciendo "cambiar cuenta"_`
            );
          } else {
            await sendWhatsAppMessage(From, 
              `📍 *${currentOrg.name}*\n\n` +
              `¡Dale! ${bestSymbol}${extractedSlots.amount.toLocaleString('es-AR')} de ${typeLabels[extractedSlots.type]} 💸\n\n` +
              `📝 ¿Cuál es el detalle de este movimiento?`
            );
          }
        }
        return;
      }
      
      // No transaction detected - use AI for general queries
      const financialContext = await getFinancialContext(user.id, organizationId!);
      // Check if this is a recent conversation (within last 10 minutes AND had prior interaction)
      // A new conversation should NOT be treated as recent - we want to greet properly on first contact
      const minutesSinceLastActivity = (Date.now() - conversation.lastActivityAt.getTime()) / 1000 / 60;
      const hadPriorInteraction = conversation.messages.length > 0 || conversation.createdAt.getTime() !== conversation.lastActivityAt.getTime();
      const isRecentConversation = minutesSinceLastActivity < 10 && hadPriorInteraction;
      const userContext: UserContext = {
        name: user.name,
        preferredName: user.preferredName || null,
        email: user.email,
        accountType: user.accountType || 'business'
      };
      const aiResponse = await generateAIResponse(message, financialContext, currentOrg.name, userContext, isRecentConversation);
      await sendWhatsAppMessage(From, aiResponse);

      return;
      } finally {
        // Task #284: liberar el lock siempre, sin importar cómo termine el
        // handler (early return, error, transacción completada, etc.).
        await __whatsappLock.release();
      }
    } catch (error) {
      console.error('[WhatsApp Webhook] Error:', error);
      return;
    } finally {
      // Task #297: apagamos el heartbeat del "escribiendo..." sí o sí,
      // sin importar cómo termine el handler (éxito, early return, error
      // o rechazo del lock). Si no se llegó a arrancar (sin MessageSid),
      // el stop es no-op.
      __typingHeartbeat.stop();
    }
  });

  app.get('/api/whatsapp/webhook', (req: Request, res: Response) => {
    res.status(200).send('WhatsApp webhook is active');
  });

  // Public bot number for the linking wizard (display + wa.me forms).
  app.get('/api/whatsapp/bot-info', (_req: Request, res: Response) => {
    const info = getBotPhoneInfo();
    res.json({
      ...info,
      defaultGreeting: 'Hola Aike',
    });
  });

  app.get('/api/whatsapp-preferences', requireAuth, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const queryOrgId = req.query.organizationId as string | undefined;
      let orgId: string | undefined = queryOrgId;
      if (!orgId) {
        const user = await storage.getUser(authReq.userId);
        if (!user) return res.status(401).json({ error: 'No autenticado' });
        orgId = user.lastActiveOrganizationId ?? undefined;
      }
      if (!orgId) return res.status(400).json({ error: 'No hay organización activa' });
      const membership = await storage.getMembershipByUserAndOrg(authReq.userId, orgId);
      if (!membership) return res.status(403).json({ error: 'No tenés acceso a esta organización' });
      const prefs = await storage.getWhatsappPreferences(authReq.userId, orgId);
      res.json(prefs || { preferredAccountId: null, preferredCurrency: null, preferredExpenseCategory: null, preferredIncomeCategory: null, defaultHasInvoice: null, orgBannerIntervalHours: null });
    } catch (error) {
      console.error('[WhatsApp Prefs] GET error:', error);
      res.status(500).json({ error: 'Error al obtener preferencias' });
    }
  });

  app.put('/api/whatsapp-preferences', requireAuth, async (req: Request, res: Response) => {
    try {
      const { organizationId: bodyOrgId, preferredAccountId, preferredCurrency, preferredExpenseCategory, preferredIncomeCategory, defaultHasInvoice, orgBannerIntervalHours } = req.body;
      let orgId = bodyOrgId;
      if (!orgId) {
        const user = await storage.getUser(req.userId);
        if (!user) return res.status(401).json({ error: 'No autenticado' });
        orgId = user.lastActiveOrganizationId;
      }
      if (!orgId) return res.status(400).json({ error: 'No hay organización activa' });
      const membership = await storage.getMembershipByUserAndOrg(req.userId, orgId);
      if (!membership) return res.status(403).json({ error: 'No tenés acceso a esta organización' });
      // Task #210 — validamos el intervalo del banner: null (default), 0 (off)
      // o entero positivo razonable (cap en 168h = 7 días).
      let bannerIntervalValue: number | null | undefined = undefined;
      if (orgBannerIntervalHours === null) {
        bannerIntervalValue = null;
      } else if (orgBannerIntervalHours !== undefined) {
        const n = Number(orgBannerIntervalHours);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 168) {
          return res.status(400).json({ error: 'orgBannerIntervalHours inválido (entero entre 0 y 168, o null)' });
        }
        bannerIntervalValue = n;
      }
      const updated = await storage.upsertWhatsappPreferences(req.userId, orgId, {
        preferredAccountId: preferredAccountId || null,
        preferredCurrency: preferredCurrency || null,
        preferredExpenseCategory: preferredExpenseCategory || null,
        preferredIncomeCategory: preferredIncomeCategory || null,
        defaultHasInvoice: defaultHasInvoice !== undefined ? defaultHasInvoice : null,
        ...(bannerIntervalValue !== undefined ? { orgBannerIntervalHours: bannerIntervalValue } : {}),
      });
      clearPatternCache(req.userId, orgId);
      // Auto-asignar como org default del bot si todavía no fue inicializada.
      // Mejora la UX para usuarios legacy: la primera vez que guardan
      // preferencias para una org, esa org queda como su default del bot.
      // Importante: usamos `whatsappDefaultOrgInitialized` para distinguir
      // "nunca fue seteada" (auto-asignar OK) de "el usuario la limpió
      // explícitamente" (NO sobrescribir). El flag se marca true en cualquier
      // PUT explícito a /api/user/whatsapp-default-organization (incluso null),
      // así un clear explícito no se revierte silenciosamente acá.
      // El frontend recibe `autoAssignedDefault: true` y muestra un toast.
      let autoAssignedDefault = false;
      const userRecord = await storage.getUser(req.userId);
      if (userRecord && !userRecord.whatsappDefaultOrgInitialized && !userRecord.whatsappDefaultOrganizationId) {
        await storage.updateUser(req.userId, {
          whatsappDefaultOrganizationId: orgId,
          whatsappDefaultOrgInitialized: true,
        });
        autoAssignedDefault = true;
      }
      res.json({ ...updated, autoAssignedDefault });
    } catch (error) {
      console.error('[WhatsApp Prefs] PUT error:', error);
      res.status(500).json({ error: 'Error al guardar preferencias' });
    }
  });

  app.get('/api/whatsapp-preferences/org-data', requireAuth, async (req: Request, res: Response) => {
    try {
      const orgId = req.query.organizationId as string;
      if (!orgId) return res.status(400).json({ error: 'organizationId requerido' });
      const membership = await storage.getMembershipByUserAndOrg(req.userId, orgId);
      if (!membership) return res.status(403).json({ error: 'No tenés acceso a esta organización' });
      const [accounts, categories] = await Promise.all([
        storage.getAccountsByOrganization(orgId),
        storage.getTransactionCategoriesByOrganization(orgId),
      ]);
      res.json({
        accounts: accounts.map(a => ({ id: a.id, name: a.name, currency: a.currency })),
        expenseCategories: categories.filter(c => c.type === 'expense'),
        incomeCategories: categories.filter(c => c.type === 'income'),
      });
    } catch (error) {
      console.error('[WhatsApp Prefs] org-data error:', error);
      res.status(500).json({ error: 'Error al obtener datos de la organización' });
    }
  });

  app.get('/api/dashboard-preferences', requireAuth, async (req: Request, res: Response) => {
    try {
      const queryOrgId = req.query.organizationId as string | undefined;
      let orgId = queryOrgId;
      if (!orgId) {
        const user = await storage.getUser(req.userId);
        if (!user) return res.status(401).json({ error: 'No autenticado' });
        orgId = user.lastActiveOrganizationId ?? undefined;
      }
      if (!orgId) return res.status(400).json({ error: 'No hay organización activa' });
      const membership = await storage.getMembershipByUserAndOrg(req.userId, orgId);
      if (!membership) return res.status(403).json({ error: 'No tenés acceso a esta organización' });
      const prefs = await storage.getDashboardPreferences(req.userId, orgId);
      res.json(prefs || { preferredAccountId: null, preferredCurrency: null, preferredExpenseCategory: null, preferredIncomeCategory: null, defaultHasInvoice: null, lastEmitSendEmail: null, lastEmitSendSelfCopy: null, lastEmitCcList: null });
    } catch (error) {
      console.error('[Dashboard Prefs] GET error:', error);
      res.status(500).json({ error: 'Error al obtener preferencias' });
    }
  });

  app.put('/api/dashboard-preferences', requireAuth, async (req: Request, res: Response) => {
    try {
      const { organizationId: bodyOrgId, preferredAccountId, preferredCurrency, preferredExpenseCategory, preferredIncomeCategory, defaultHasInvoice, lastEmitSendEmail, lastEmitSendSelfCopy, lastEmitCcList } = req.body;
      let orgId = bodyOrgId;
      if (!orgId) {
        const user = await storage.getUser(req.userId);
        if (!user) return res.status(401).json({ error: 'No autenticado' });
        orgId = user.lastActiveOrganizationId;
      }
      if (!orgId) return res.status(400).json({ error: 'No hay organización activa' });
      const membership = await storage.getMembershipByUserAndOrg(req.userId, orgId);
      if (!membership) return res.status(403).json({ error: 'No tenés acceso a esta organización' });
      const existing = await storage.getDashboardPreferences(req.userId, orgId);
      const updates: Partial<InsertDashboardPreferences> = {};
      if (preferredAccountId !== undefined) updates.preferredAccountId = preferredAccountId || null;
      else if (existing) updates.preferredAccountId = existing.preferredAccountId;
      if (preferredCurrency !== undefined) updates.preferredCurrency = preferredCurrency || null;
      else if (existing) updates.preferredCurrency = existing.preferredCurrency;
      if (preferredExpenseCategory !== undefined) updates.preferredExpenseCategory = preferredExpenseCategory || null;
      else if (existing) updates.preferredExpenseCategory = existing.preferredExpenseCategory;
      if (preferredIncomeCategory !== undefined) updates.preferredIncomeCategory = preferredIncomeCategory || null;
      else if (existing) updates.preferredIncomeCategory = existing.preferredIncomeCategory;
      if (defaultHasInvoice !== undefined) updates.defaultHasInvoice = defaultHasInvoice;
      else if (existing) updates.defaultHasInvoice = existing.defaultHasInvoice;
      if (lastEmitSendEmail !== undefined) updates.lastEmitSendEmail = lastEmitSendEmail;
      if (lastEmitSendSelfCopy !== undefined) updates.lastEmitSendSelfCopy = lastEmitSendSelfCopy;
      if (lastEmitCcList !== undefined) updates.lastEmitCcList = Array.isArray(lastEmitCcList) ? lastEmitCcList : null;
      const updated = await storage.upsertDashboardPreferences(req.userId, orgId, updates);
      res.json(updated);
    } catch (error) {
      console.error('[Dashboard Prefs] PUT error:', error);
      res.status(500).json({ error: 'Error al guardar preferencias' });
    }
  });

  // ============================================================================
  // CLIENT INVOICE EMAIL PREFERENCES
  // Per-client overrides for invoice-email sending preferences (CC, BCC self).
  // ============================================================================
  app.get('/api/clients/:clientId/invoice-email-prefs', requireAuth, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;
      const user = await storage.getUser(req.userId);
      if (!user) return res.status(401).json({ error: 'No autenticado' });
      const orgId = (req.query.organizationId as string | undefined) || user.lastActiveOrganizationId;
      if (!orgId) return res.status(400).json({ error: 'No hay organización activa' });
      const membership = await storage.getMembershipByUserAndOrg(req.userId, orgId);
      if (!membership) return res.status(403).json({ error: 'No tenés acceso a esta organización' });
      const client = await storage.getClient(clientId);
      if (!client || client.organizationId !== orgId) return res.status(404).json({ error: 'Cliente no encontrado' });
      const prefs = await storage.getClientInvoiceEmailPrefs(clientId);
      res.json(prefs || { defaultCcEmails: [], sendCopyToSelf: false });
    } catch (error) {
      console.error('[Client Invoice Email Prefs] GET error:', error);
      res.status(500).json({ error: 'Error al obtener preferencias de email' });
    }
  });

  app.put('/api/clients/:clientId/invoice-email-prefs', requireAuth, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;
      const { defaultCcEmails, sendCopyToSelf, organizationId: bodyOrgId } = req.body || {};
      const user = await storage.getUser(req.userId);
      if (!user) return res.status(401).json({ error: 'No autenticado' });
      const orgId = bodyOrgId || user.lastActiveOrganizationId;
      if (!orgId) return res.status(400).json({ error: 'No hay organización activa' });
      const membership = await storage.getMembershipByUserAndOrg(req.userId, orgId);
      if (!membership) return res.status(403).json({ error: 'No tenés acceso a esta organización' });
      const client = await storage.getClient(clientId);
      if (!client || client.organizationId !== orgId) return res.status(404).json({ error: 'Cliente no encontrado' });

      const isValidEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((e || '').trim());
      const ccArr = Array.isArray(defaultCcEmails)
        ? defaultCcEmails.map((s: any) => String(s).trim()).filter((s: string) => s.length > 0)
        : [];
      for (const cc of ccArr) {
        if (!isValidEmail(cc)) {
          return res.status(400).json({ error: `Email CC inválido: ${cc}` });
        }
      }
      const updated = await storage.upsertClientInvoiceEmailPrefs(orgId, clientId, {
        defaultCcEmails: ccArr,
        sendCopyToSelf: !!sendCopyToSelf,
      });
      res.json(updated);
    } catch (error) {
      console.error('[Client Invoice Email Prefs] PUT error:', error);
      res.status(500).json({ error: 'Error al guardar preferencias de email' });
    }
  });

  console.log('[WhatsApp] Routes registered');
}
