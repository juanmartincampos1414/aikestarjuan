import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "../storage";
import { sanitizeError } from "./middleware";
import { getUncachableStripeClient } from "../stripeClient";
import { sendAdminPromotionEmail, sendAdminNotificationEmail, sendPasswordResetEmail, getAppBaseUrl } from "../services/email";
import bcrypt from "bcryptjs";
import { runWeeklyDigestForAllUsers, generateWeeklyDigestForUser } from "../services/weeklyDigest";
import { z } from "zod";
import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import { randomUUID } from "crypto";
import multer from "multer";

const adminUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
import { db } from "../db";
import { transactions, accounts, updateBusinessSettingsSchema, upsertAcquisitionSpendSchema, updateAcquisitionConfigSchema } from "@shared/schema";
import { computeAdminBusinessMetrics, resolveBusinessSettings } from "../services/businessMetrics";
import {
  configFromSettings,
  configHasTags,
  deriveAcquisitionSpendByMonth,
  mergeAcquisitionSpend,
  buildItemCodesByTx,
} from "../lib/acquisitionSpend";
import { eq, like, sql, and, inArray } from "drizzle-orm";

interface AuthenticatedRequest extends Request {
  userId: string;
}

async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;
  
  if (!req.session?.userId) {
    return res.status(401).json({ message: "No autenticado" });
  }
  
  authReq.userId = req.session.userId;
  
  const isAdmin = await storage.isUserAdmin(req.session.userId);
  if (!isAdmin) {
    return res.status(403).json({ message: "Acceso denegado" });
  }
  
  next();
}

export function registerAdminRoutes(app: Express): void {
  app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      
      const usersWithSubscriptions = await Promise.all(
        users.map(async (user) => {
          let subscription = null;
          let stripeSubscription = null;
          
          try {
            subscription = await storage.getSubscriptionByUserId(user.id);
          } catch {}
          
          if (user.stripeSubscriptionId) {
            try {
              const stripe = await getUncachableStripeClient();
              stripeSubscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId, {
                expand: ['default_payment_method', 'latest_invoice']
              });
            } catch {}
          }
          
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            accountType: user.accountType,
            isAdmin: user.isAdmin,
            createdAt: user.createdAt,
            deletedAt: user.deletedAt,
            phoneNumber: user.phoneNumber,
            phoneVerified: user.phoneVerified,
            stripeCustomerId: user.stripeCustomerId,
            stripeSubscriptionId: user.stripeSubscriptionId,
            subscription: subscription ? {
              id: subscription.id,
              planType: subscription.planType,
              status: subscription.status,
              currentPeriodStart: subscription.currentPeriodStart,
              currentPeriodEnd: subscription.currentPeriodEnd,
              paymentFailedAt: subscription.paymentFailedAt,
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            } : null,
            stripeStatus: stripeSubscription?.status || null,
          };
        })
      );
      
      res.json(usersWithSubscriptions);
    } catch (error: any) {
      console.error('[Admin] Error fetching users:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/admin/metrics', requireAdmin, async (req, res) => {
    try {
      const metrics = await computeAdminBusinessMetrics();
      res.json(metrics);
    } catch (error: any) {
      console.error('[Admin] Error fetching metrics:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Histórico mensual del MRR para graficar su evolución en /admin.
  app.get('/api/admin/mrr-snapshots', requireAdmin, async (req, res) => {
    try {
      const snapshots = await storage.getMrrSnapshots();
      res.json(snapshots);
    } catch (error: any) {
      console.error('[Admin] Error fetching MRR snapshots:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Disparo manual del snapshot del mes en curso (útil para sembrar el gráfico
  // sin esperar al cron diario).
  app.post('/api/admin/mrr-snapshots/run', requireAdmin, async (req, res) => {
    try {
      const { captureMrrSnapshot } = await import("../services/mrrSnapshot");
      const snapshot = await captureMrrSnapshot();
      res.json(snapshot);
    } catch (error: any) {
      console.error('[Admin] Error running MRR snapshot:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Valores de negocio editables desde el panel admin: tipo de cambio USD/ARS
  // de referencia y estimaciones de SaaS (CAC min/max, ratio LTV/CAC).
  app.get('/api/admin/business-settings', requireAdmin, async (req, res) => {
    try {
      const settings = await resolveBusinessSettings();
      res.json(settings);
    } catch (error: any) {
      console.error('[Admin] Error fetching business settings:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.put('/api/admin/business-settings', requireAdmin, async (req, res) => {
    try {
      const validation = updateBusinessSettingsSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: validation.error.errors });
      }
      const currentAdmin = req as AuthenticatedRequest;
      await storage.upsertBusinessSettings(validation.data, currentAdmin.userId);
      const settings = await resolveBusinessSettings();
      res.json(settings);
    } catch (error: any) {
      console.error('[Admin] Error updating business settings:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Gasto de adquisición (marketing/ventas) por mes, base del CAC real.
  app.get('/api/admin/acquisition-spend', requireAdmin, async (req, res) => {
    try {
      const spends = await storage.getAcquisitionSpends();
      res.json(spends);
    } catch (error: any) {
      console.error('[Admin] Error fetching acquisition spend:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.put('/api/admin/acquisition-spend', requireAdmin, async (req, res) => {
    try {
      const validation = upsertAcquisitionSpendSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: validation.error.errors });
      }
      const currentAdmin = req as AuthenticatedRequest;
      const row = await storage.upsertAcquisitionSpend(validation.data, currentAdmin.userId);
      res.json(row);
    } catch (error: any) {
      console.error('[Admin] Error upserting acquisition spend:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/admin/acquisition-spend/:month', requireAdmin, async (req, res) => {
    try {
      const month = req.params.month;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return res.status(400).json({ message: 'Mes inválido' });
      }
      await storage.deleteAcquisitionSpend(month);
      res.json({ success: true });
    } catch (error: any) {
      console.error('[Admin] Error deleting acquisition spend:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // ===== Derivación automática del gasto de adquisición (Task #433) =====
  // Configuración: qué organización y qué cuentas/categorías/códigos de análisis
  // cuentan como gasto de adquisición.
  app.get('/api/admin/acquisition-config', requireAdmin, async (req, res) => {
    try {
      const row = await storage.getBusinessSettings();
      res.json({
        acquisitionAutoEnabled: row?.acquisitionAutoEnabled ?? false,
        acquisitionOrgId: row?.acquisitionOrgId ?? null,
        acquisitionAccountIds: row?.acquisitionAccountIds ?? [],
        acquisitionCategories: row?.acquisitionCategories ?? [],
        acquisitionProfitabilityCodeIds: row?.acquisitionProfitabilityCodeIds ?? [],
      });
    } catch (error: any) {
      console.error('[Admin] Error fetching acquisition config:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.put('/api/admin/acquisition-config', requireAdmin, async (req, res) => {
    try {
      const validation = updateAcquisitionConfigSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: validation.error.errors });
      }
      const currentAdmin = req as AuthenticatedRequest;
      const row = await storage.upsertAcquisitionConfig(validation.data, currentAdmin.userId);
      res.json({
        acquisitionAutoEnabled: row.acquisitionAutoEnabled,
        acquisitionOrgId: row.acquisitionOrgId,
        acquisitionAccountIds: row.acquisitionAccountIds,
        acquisitionCategories: row.acquisitionCategories,
        acquisitionProfitabilityCodeIds: row.acquisitionProfitabilityCodeIds,
      });
    } catch (error: any) {
      console.error('[Admin] Error updating acquisition config:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Lista de organizaciones (para el selector del panel de derivación).
  app.get('/api/admin/organizations', requireAdmin, async (req, res) => {
    try {
      const orgs = await storage.getAllOrganizations();
      res.json(orgs.map((o) => ({ id: o.id, name: o.name })));
    } catch (error: any) {
      console.error('[Admin] Error fetching organizations:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Opciones de etiquetado (cuentas, categorías de gasto y códigos de análisis)
  // de una organización, para construir el selector de qué cuenta como gasto de
  // adquisición.
  app.get('/api/admin/acquisition-config/options', requireAdmin, async (req, res) => {
    try {
      const orgId = typeof req.query.orgId === 'string' ? req.query.orgId : '';
      if (!orgId) {
        return res.status(400).json({ message: 'orgId es requerido' });
      }
      const [accountsList, categories, codes] = await Promise.all([
        storage.getAccountsByOrganization(orgId),
        storage.getTransactionCategoriesByOrganization(orgId, 'expense'),
        storage.getProfitabilityCodesByOrganization(orgId, false, false),
      ]);
      res.json({
        accounts: accountsList.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
        // Las categorías de gasto se etiquetan por nombre (transactions.category
        // guarda el nombre, no un id).
        categories: Array.from(new Set(categories.map((c) => c.name))).map((name) => ({ name })),
        profitabilityCodes: codes.map((c) => ({ id: c.id, code: c.code, name: c.name })),
      });
    } catch (error: any) {
      console.error('[Admin] Error fetching acquisition config options:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Vista previa del gasto por mes ya combinado (manual + derivado), para que el
  // admin vea de dónde sale el CAC. 'source' indica si ese mes vino de la carga
  // manual o del derivado de transacciones etiquetadas.
  app.get('/api/admin/acquisition-spend/derived', requireAdmin, async (req, res) => {
    try {
      const settings = await resolveBusinessSettings();
      const row = await storage.getBusinessSettings();
      const manual = await storage.getAcquisitionSpends();
      const config = configFromSettings(row);

      let derived = new Map<string, number>();
      if (config.enabled && config.orgId && configHasTags(config)) {
        const txs = await storage.getTransactionsByOrganization(config.orgId, 'completed');
        // #477: incluir códigos de rentabilidad de los renglones para no
        // subcontar ventas/compras multi-producto (campo legacy en null).
        const items = await storage.getTransactionItemsByTransactionIds(txs.map((t) => t.id));
        const itemCodesByTx = buildItemCodesByTx(items);
        derived = deriveAcquisitionSpendByMonth(txs, config, settings.usdArsRate, itemCodesByTx);
      }

      const merged = mergeAcquisitionSpend(manual, derived);
      res.json({
        enabled: config.enabled && !!config.orgId && configHasTags(config),
        months: merged,
      });
    } catch (error: any) {
      console.error('[Admin] Error computing derived acquisition spend:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/admin/session-logs', requireAdmin, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const logs = await storage.getAllSessionLogs(limit);
      
      const logsWithUserInfo = await Promise.all(
        logs.map(async (log) => {
          const user = await storage.getUser(log.userId);
          return {
            ...log,
            userEmail: user?.email || 'Usuario eliminado',
            userName: user?.name || 'Desconocido',
          };
        })
      );
      
      res.json(logsWithUserInfo);
    } catch (error: any) {
      console.error('[Admin] Error fetching session logs:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // ===== Panel de errores del sistema =====
  const SYSTEM_ERROR_STATUSES = ['open', 'resolved', 'archived'] as const;

  app.get('/api/admin/system-errors', requireAdmin, async (req, res) => {
    try {
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
      const status = statusParam && (SYSTEM_ERROR_STATUSES as readonly string[]).includes(statusParam)
        ? statusParam
        : undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);

      const errors = await storage.getSystemErrors(status, limit);

      const orgNameCache = new Map<string, string | null>();
      const enriched = await Promise.all(errors.map(async (err) => {
        let organizationName: string | null = null;
        if (err.organizationId) {
          if (orgNameCache.has(err.organizationId)) {
            organizationName = orgNameCache.get(err.organizationId) ?? null;
          } else {
            try {
              const org = await storage.getOrganization(err.organizationId);
              organizationName = org?.name ?? null;
            } catch {
              organizationName = null;
            }
            orgNameCache.set(err.organizationId, organizationName);
          }
        }
        return { ...err, organizationName };
      }));

      res.json(enriched);
    } catch (error: any) {
      console.error('[Admin] Error fetching system errors:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/admin/system-errors/:id', requireAdmin, async (req, res) => {
    try {
      const error = await storage.getSystemError(req.params.id);
      if (!error) {
        return res.status(404).json({ message: 'Error no encontrado' });
      }
      let organizationName: string | null = null;
      if (error.organizationId) {
        try {
          const org = await storage.getOrganization(error.organizationId);
          organizationName = org?.name ?? null;
        } catch {
          organizationName = null;
        }
      }
      res.json({ ...error, organizationName });
    } catch (error: any) {
      console.error('[Admin] Error fetching system error detail:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  const updateSystemErrorSchema = z.object({
    status: z.enum(SYSTEM_ERROR_STATUSES),
  });

  app.patch('/api/admin/system-errors/:id/status', requireAdmin, async (req, res) => {
    try {
      const validation = updateSystemErrorSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ message: 'Estado inválido', errors: validation.error.errors });
      }
      const { status } = validation.data;
      const currentAdmin = req as AuthenticatedRequest;
      const updated = await storage.updateSystemErrorStatus(
        req.params.id,
        status,
        status === 'resolved' ? currentAdmin.userId : null,
      );
      if (!updated) {
        return res.status(404).json({ message: 'Error no encontrado' });
      }
      res.json(updated);
    } catch (error: any) {
      if (error?.code === 'OPEN_EXISTS') {
        return res.status(409).json({
          message: 'Ya existe un registro abierto para este error. Gestioná el registro abierto actual.',
        });
      }
      console.error('[Admin] Error updating system error status:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/admin/check', async (req, res) => {
    if (!req.session?.userId) {
      return res.json({ isAdmin: false });
    }
    
    try {
      const isAdmin = await storage.isUserAdmin(req.session.userId);
      res.json({ isAdmin });
    } catch (error) {
      res.json({ isAdmin: false });
    }
  });

  app.patch('/api/admin/users/:userId/toggle-admin', requireAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const currentAdmin = req as AuthenticatedRequest;
      
      if (userId === currentAdmin.userId) {
        return res.status(400).json({ message: 'No podés modificar tu propio estado de admin' });
      }
      
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      
      const newIsAdmin = !user.isAdmin;
      await storage.updateUser(userId, { isAdmin: newIsAdmin });
      
      console.log('[Admin] Toggle admin for user:', userId, 'newIsAdmin:', newIsAdmin, 'by:', currentAdmin.userId);
      
      // Send email notification when promoting to admin
      let emailSent = false;
      let emailError: string | null = null;
      
      if (newIsAdmin) {
        const currentAdminUser = await storage.getUser(currentAdmin.userId);
        const promotedByName = currentAdminUser?.name || 'Un administrador';
        const userName = user.name || user.email.split('@')[0] || 'Usuario';
        
        console.log('[Admin] Attempting to send admin promotion email:', {
          to: user.email,
          userName,
          promotedBy: promotedByName
        });
        
        try {
          // Send email synchronously to capture result
          emailSent = await sendAdminPromotionEmail(user.email, userName, promotedByName);
          if (emailSent) {
            console.log('[Admin] Admin promotion email sent successfully to:', user.email);
          } else {
            emailError = 'Email function returned false';
            console.error('[Admin] Admin promotion email returned false for:', user.email);
          }
        } catch (err: any) {
          emailError = err.message || 'Unknown error';
          console.error('[Admin] Failed to send admin promotion email to:', user.email, 'Error:', emailError);
        }
      }
      
      res.json({ 
        success: true, 
        userId, 
        isAdmin: newIsAdmin,
        message: newIsAdmin ? 'Usuario promovido a admin' : 'Admin removido del usuario',
        emailSent: newIsAdmin ? emailSent : undefined,
        emailError: newIsAdmin && emailError ? emailError : undefined
      });
    } catch (error: any) {
      console.error('[Admin] Error toggling admin:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  const sendNotificationSchema = z.object({
    title: z.string().min(1, 'Título es requerido'),
    message: z.string().min(1, 'Mensaje es requerido'),
    userIds: z.union([z.literal('all'), z.array(z.string().uuid())]),
    sendMethod: z.enum(['app', 'email', 'both']).default('app'),
    imageUrl: z.string().nullable().optional(),
    attachmentUrl: z.string().nullable().optional(),
    attachmentName: z.string().nullable().optional(),
  });

  app.post('/api/admin/notifications/send', requireAdmin, async (req, res) => {
    try {
      const validationResult = sendNotificationSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ 
          message: 'Datos inválidos', 
          errors: validationResult.error.errors 
        });
      }
      
      const { title, message, userIds, sendMethod, imageUrl, attachmentUrl, attachmentName } = validationResult.data;
      
      const shouldSendNotification = sendMethod === 'app' || sendMethod === 'both';
      const shouldSendEmail = sendMethod === 'email' || sendMethod === 'both';
      
      let targetUserIds: string[] = [];
      
      if (userIds === 'all') {
        const allUsers = await storage.getAllUsers();
        targetUserIds = allUsers.map(u => u.id);
      } else {
        targetUserIds = userIds;
      }
      
      if (targetUserIds.length === 0) {
        return res.status(400).json({ message: 'No hay usuarios para notificar' });
      }
      
      console.log(`[Admin Notifications] Sending to ${targetUserIds.length} users, method: ${sendMethod} (app: ${shouldSendNotification}, email: ${shouldSendEmail})`);
      
      let notificationsSent = 0;
      let emailsSent = 0;
      const errors: string[] = [];
      
      for (const userId of targetUserIds) {
        try {
          if (shouldSendNotification) {
            const userOrgs = await storage.getOrganizationsByUser(userId);
            
            for (const org of userOrgs) {
              try {
                await storage.createNotification({
                  userId,
                  organizationId: org.id,
                  type: 'announcement',
                  priority: 'medium',
                  title,
                  message,
                  imageUrl: imageUrl || null,
                  attachmentUrl: attachmentUrl || null,
                  attachmentName: attachmentName || null,
                  transactionId: null,
                  isRead: false,
                  source: 'auto',
                });
                notificationsSent++;
              } catch (err: any) {
                errors.push(`Error creating notification for user ${userId}: ${err.message}`);
              }
            }
          }
          
          if (shouldSendEmail) {
            const user = await storage.getUser(userId);
            if (user) {
              try {
                const sent = await sendAdminNotificationEmail(
                  user.email,
                  user.name || user.email.split('@')[0],
                  title,
                  message,
                  imageUrl,
                  attachmentUrl,
                  attachmentName
                );
                if (sent) emailsSent++;
              } catch (emailErr: any) {
                errors.push(`Error sending email to ${user.email}: ${emailErr.message}`);
              }
            }
          }
        } catch (userErr: any) {
          errors.push(`Error processing user ${userId}: ${userErr.message}`);
        }
      }
      
      console.log(`[Admin Notifications] Sent ${notificationsSent} notifications and ${emailsSent} emails. Errors: ${errors.length}`);
      
      res.json({ 
        success: true,
        notificationsSent,
        emailsSent,
        errors: errors.length > 0 ? errors : undefined,
        message: `Se enviaron ${notificationsSent} notificaciones${emailsSent > 0 ? ` y ${emailsSent} emails` : ''}`
      });
    } catch (error: any) {
      console.error('[Admin Notifications] Error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/admin/upload', requireAdmin, adminUpload.single('file'), async (req: Request & { file?: Express.Multer.File }, res) => {
    try {
      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        return res.status(400).json({ message: 'No se encontró archivo' });
      }

      const uploadType = (req.body?.type === 'attachment') ? 'attachment' : 'notification';
      const fileName = file.originalname || 'upload';
      const fileMimeType = file.mimetype || 'application/octet-stream';

      const privateDir = process.env.PRIVATE_OBJECT_DIR;
      if (!privateDir) {
        return res.status(500).json({ message: 'Almacenamiento no configurado' });
      }

      const ext = fileName.includes('.') ? fileName.split('.').pop() : 'bin';
      const fileId = randomUUID();
      const folder = uploadType === 'attachment' ? 'attachments' : 'notifications';
      const objectPath = `${folder}/${fileId}.${ext}`;
      const fullPath = `${privateDir}/${objectPath}`;

      const pathParts = fullPath.split('/').filter(p => p);
      const bucketName = pathParts[0];
      const objectName = pathParts.slice(1).join('/');

      const bucket = objectStorageClient.bucket(bucketName);
      const objectFile = bucket.file(objectName);

      await objectFile.save(file.buffer, {
        contentType: fileMimeType,
        metadata: {
          originalName: fileName,
          uploadType,
        }
      });

      console.log(`[Admin Upload] Saved file: ${objectPath} (${file.buffer.length} bytes)`);

      res.json({
        success: true,
        url: `/objects/${objectPath}`,
        originalName: fileName,
      });
    } catch (error: any) {
      console.error('[Admin Upload] Error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/admin/weekly-digest/trigger', requireAdmin, async (req, res) => {
    try {
      const result = await runWeeklyDigestForAllUsers();
      res.json({ message: 'Resumen semanal enviado', ...result });
    } catch (error: any) {
      console.error('[Admin] Weekly digest trigger error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/admin/weekly-digest/test', requireAdmin, async (req: any, res) => {
    try {
      const result = await generateWeeklyDigestForUser(req.userId);
      res.json({ message: 'Resumen de prueba enviado a tu email', ...result });
    } catch (error: any) {
      console.error('[Admin] Weekly digest test error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/admin/cleanup-orphaned-cancellations', requireAdmin, async (req, res) => {
    try {
      const dryRun = req.query.dryRun !== 'false';
      const orgId = req.query.orgId as string | undefined;

      const conditions = [like(transactions.description, '[CANCELACIÓN]%')];
      if (orgId) conditions.push(eq(transactions.organizationId, orgId));

      const allCancellations = await db
        .select()
        .from(transactions)
        .where(and(...conditions));

      const orphaned: typeof allCancellations = [];

      for (const cancel of allCancellations) {
        let originalId: string | null = null;
        if (cancel.originalTransactionData) {
          try {
            const parsed = typeof cancel.originalTransactionData === 'string'
              ? JSON.parse(cancel.originalTransactionData)
              : cancel.originalTransactionData;
            originalId = parsed?.id || null;
          } catch { /* ignore parse errors */ }
        }

        if (originalId) {
          const [orig] = await db
            .select({ id: transactions.id })
            .from(transactions)
            .where(eq(transactions.id, originalId));
          if (!orig) {
            orphaned.push(cancel);
          }
          continue;
        }

        if (cancel.linkedTransactionId) {
          const [linked] = await db
            .select({ id: transactions.id })
            .from(transactions)
            .where(eq(transactions.id, cancel.linkedTransactionId));
          if (!linked) {
            orphaned.push(cancel);
          }
          continue;
        }

        const inverseType = cancel.type === 'income' ? 'expense'
          : cancel.type === 'expense' ? 'income'
          : cancel.type === 'receivable' ? 'payable'
          : cancel.type === 'payable' ? 'receivable'
          : cancel.type;

        const matchConds = [
          eq(transactions.organizationId, cancel.organizationId),
          eq(transactions.type, inverseType),
          eq(transactions.amount, cancel.amount),
        ];

        if (cancel.supplierId) matchConds.push(eq(transactions.supplierId, cancel.supplierId));
        if (cancel.clientId) matchConds.push(eq(transactions.clientId, cancel.clientId));

        const matches = await db
          .select({ id: transactions.id })
          .from(transactions)
          .where(and(...matchConds));

        if (matches.length === 0) {
          orphaned.push(cancel);
        }
      }

      type CleanupDetail = { id: string; description: string; amount: string; type: string; balanceAdjusted: boolean; orgId: string };
      const details: CleanupDetail[] = orphaned.map(orph => ({
        id: orph.id,
        description: orph.description || '',
        amount: orph.amount,
        type: orph.type,
        balanceAdjusted: !!(orph.status === 'completed' && orph.accountId),
        orgId: orph.organizationId,
      }));

      if (orphaned.length === 0) {
        return res.json({ message: 'No se encontraron registros huérfanos', dryRun, cleaned: 0, details: [] });
      }

      if (dryRun) {
        return res.json({ message: `Modo prueba: ${orphaned.length} registros huérfanos encontrados (no eliminados)`, dryRun: true, cleaned: 0, wouldClean: orphaned.length, details });
      }

      await db.transaction(async (tx) => {
        for (const orph of orphaned) {
          if (orph.status === 'completed' && orph.accountId) {
            const amount = parseFloat(orph.amount);
            const wasPositive = orph.type === 'income' || orph.type === 'transfer_in' || orph.type === 'receivable';
            const delta = wasPositive ? -amount : amount;
            await tx.update(accounts)
              .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${delta})` })
              .where(eq(accounts.id, orph.accountId));
            console.log(`[Cleanup] Reversed balance for orphan ${orph.id}: account ${orph.accountId} adjusted by ${delta}`);
          }

          await tx.delete(transactions).where(eq(transactions.id, orph.id));
          console.log(`[Cleanup] Deleted orphaned cancellation: ${orph.id} "${orph.description}"`);
        }
      });

      res.json({ message: `Limpieza completada: ${orphaned.length} registros huérfanos eliminados`, dryRun: false, cleaned: orphaned.length, details });
    } catch (error: any) {
      console.error('[Admin] Cleanup error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  const generateResetLinkSchema = z.object({
    email: z.string().email('Email inválido'),
    sendEmail: z.boolean().optional().default(false),
  });

  app.post('/api/admin/generate-reset-link', requireAdmin, async (req, res) => {
    try {
      const validationResult = generateResetLinkSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          message: 'Datos inválidos',
          errors: validationResult.error.errors,
        });
      }

      const email = validationResult.data.email.toLowerCase().trim();
      const sendEmail = validationResult.data.sendEmail;

      const user = await storage.getUserByActiveEmail(email);
      if (!user) {
        return res.status(404).json({ message: 'No existe una cuenta activa con ese email' });
      }

      const token = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await storage.createPasswordReset({
        userId: user.id,
        token: await bcrypt.hash(token, 10),
        expiresAt,
      });

      const resetLink = `${getAppBaseUrl()}/api/auth/reset-redirect?email=${encodeURIComponent(user.email)}&token=${token}`;

      let emailSent: boolean | undefined;
      if (sendEmail) {
        try {
          emailSent = await sendPasswordResetEmail(user.email, user.name, token);
        } catch {
          emailSent = false;
        }
      }

      const currentAdmin = req as AuthenticatedRequest;
      console.log('[Admin] Reset link generated for:', user.email, 'by admin:', currentAdmin.userId);

      res.json({
        success: true,
        email: user.email,
        name: user.name,
        resetLink,
        expiresAt,
        emailSent,
      });
    } catch (error: any) {
      console.error('[Admin] Generate reset link error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/admin/cleanup-cancellation-cc-links', requireAdmin, async (req, res) => {
    try {
      const dryRun = req.query.dryRun !== 'false';

      const cancellationsWithLinks = await db
        .select({ id: transactions.id, description: transactions.description, clientId: transactions.clientId, supplierId: transactions.supplierId, organizationId: transactions.organizationId })
        .from(transactions)
        .where(and(
          like(transactions.description, '[CANCELACIÓN]%'),
          sql`(${transactions.clientId} IS NOT NULL OR ${transactions.supplierId} IS NOT NULL)`,
        ));

      if (cancellationsWithLinks.length === 0) {
        return res.json({ message: 'No cancellation records with clientId/supplierId found', dryRun, cleaned: 0 });
      }

      const details = cancellationsWithLinks.map(c => ({
        id: c.id,
        description: c.description,
        clientId: c.clientId,
        supplierId: c.supplierId,
        organizationId: c.organizationId,
      }));

      if (dryRun) {
        return res.json({ message: `Dry run: ${cancellationsWithLinks.length} cancellation records with CC links found`, dryRun: true, wouldClean: cancellationsWithLinks.length, details });
      }

      await db.update(transactions)
        .set({ clientId: null, supplierId: null })
        .where(and(
          like(transactions.description, '[CANCELACIÓN]%'),
          sql`(${transactions.clientId} IS NOT NULL OR ${transactions.supplierId} IS NOT NULL)`,
        ));

      console.log(`[Admin] Cleaned ${cancellationsWithLinks.length} cancellation records: removed clientId/supplierId links`);
      res.json({ message: `Cleaned ${cancellationsWithLinks.length} cancellation records`, dryRun: false, cleaned: cancellationsWithLinks.length, details });
    } catch (error: any) {
      console.error('[Admin] Cleanup CC links error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
}
