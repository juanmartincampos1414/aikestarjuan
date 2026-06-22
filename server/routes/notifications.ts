import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "../storage";
import { sanitizeError } from "./middleware";
import { generateCommitmentNotifications, generateNotificationsForAllOrgs } from "../services/commitmentNotifications";

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authReq = req;
  
  if (!req.session?.userId) {
    return res.status(401).json({ message: "No autenticado" });
  }
  
  authReq.userId = req.session.userId;
  
  const orgId = req.headers['x-organization-id'] as string;
  if (orgId) {
    authReq.organizationId = orgId;
  }
  
  next();
}

export function registerNotificationRoutes(app: Express): void {
  app.get('/api/notifications', requireAuth, async (req: any, res) => {
    try {
      const { includeRead = 'true', organizationId, allOrgs } = req.query;
      const orgId = allOrgs === 'true' ? undefined : (organizationId || req.organizationId);
      
      await generateNotificationsForAllOrgs(req.userId);
      
      const notifications = await storage.getNotificationsByUser(
        req.userId,
        orgId,
        includeRead === 'true'
      );
      
      res.json(notifications);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/notifications/count', requireAuth, async (req: any, res) => {
    try {
      const { organizationId } = req.query;
      const orgId = organizationId || req.organizationId;
      
      const count = await storage.getUnreadNotificationCount(req.userId, orgId);
      
      res.json({ count });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/notifications/summary', requireAuth, async (req: any, res) => {
    try {
      await generateNotificationsForAllOrgs(req.userId);

      const [notifications, unreadCount, userOrgs] = await Promise.all([
        storage.getNotificationsByUser(req.userId, undefined, true),
        storage.getUnreadNotificationCount(req.userId, req.organizationId),
        storage.getOrganizationsByUser(req.userId),
      ]);

      const pendingResult = await (async () => {
          const now = new Date();
          const warningDays = 7;
          const clickedIds = new Set(
            notifications.filter(n => n.transactionId && n.source === 'user_click').map(n => n.transactionId)
          );
          const pending: any[] = [];
          for (const org of userOrgs) {
            const txs = await storage.getTransactionsByOrganization(org.id);
            for (const tx of txs) {
              if ((tx.type === 'payable' || tx.type === 'receivable') && tx.status === 'scheduled' && !clickedIds.has(tx.id)) {
                const dueDate = tx.imputationDate ? new Date(tx.imputationDate) : new Date(tx.date);
                const argOff = -3 * 3600000;
                const dueDateArg = new Date(dueDate.getTime() + argOff);
                const nowArg = new Date(now.getTime() + argOff);
                const dueDateNorm = new Date(Date.UTC(dueDateArg.getUTCFullYear(), dueDateArg.getUTCMonth(), dueDateArg.getUTCDate()));
                const nowNorm = new Date(Date.UTC(nowArg.getUTCFullYear(), nowArg.getUTCMonth(), nowArg.getUTCDate()));
                const daysUntilDue = Math.round((dueDateNorm.getTime() - nowNorm.getTime()) / 86400000);
                if (daysUntilDue <= warningDays) {
                  let priority: 'urgent' | 'warning' | 'info' = 'info';
                  let title = '';
                  if (daysUntilDue < 0) { priority = 'urgent'; title = tx.type === 'payable' ? `Pago vencido hace ${Math.abs(daysUntilDue)} días` : `Cobro vencido hace ${Math.abs(daysUntilDue)} días`; }
                  else if (daysUntilDue <= 2) { priority = 'urgent'; title = tx.type === 'payable' ? `Pago vence ${daysUntilDue === 0 ? 'hoy' : daysUntilDue === 1 ? 'mañana' : `en ${daysUntilDue} días`}` : `Cobro vence ${daysUntilDue === 0 ? 'hoy' : daysUntilDue === 1 ? 'mañana' : `en ${daysUntilDue} días`}`; }
                  else { priority = 'warning'; title = tx.type === 'payable' ? `Pago en ${daysUntilDue} días` : `Cobro en ${daysUntilDue} días`; }
                  pending.push({ id: tx.id, type: tx.type, title, description: tx.description ?? 'Sin descripción', amount: tx.amount, currency: tx.currency ?? 'ARS', dueDate: dueDate.toISOString(), daysUntilDue, priority, organizationId: org.id, organizationName: org.name });
                }
              }
            }
          }
          pending.sort((a, b) => {
            const po: any = { urgent: 0, warning: 1, info: 2 };
            return po[a.priority] !== po[b.priority] ? po[a.priority] - po[b.priority] : a.daysUntilDue - b.daysUntilDue;
          });
          return { notifications: pending, unreadCount: pending.filter((n: any) => n.priority === 'urgent').length, totalCount: pending.length };
        })();

      res.json({ notifications, unreadCount, pending: pendingResult });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/notifications/:id/read', requireAuth, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      const notification = await storage.markNotificationRead(id);
      
      if (!notification) {
        return res.status(404).json({ message: "Notificación no encontrada" });
      }
      
      res.json(notification);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/notifications/mark-all-read', requireAuth, async (req: any, res) => {
    try {
      const { organizationId } = req.body;
      const orgId = organizationId || req.organizationId;
      
      const count = await storage.markAllNotificationsRead(req.userId, orgId);
      
      res.json({ marked: count });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/notifications/:id', requireAuth, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      await storage.deleteNotification(id);
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/notifications/from-pending', requireAuth, async (req: any, res) => {
    try {
      const { transactionId, organizationId, type, title, description, amount, currency, daysUntilDue } = req.body;
      
      const existingNotifications = await storage.getNotificationsByUser(req.userId, organizationId, true);
      const existing = existingNotifications.find(n => n.transactionId === transactionId);
      
      if (existing) {
        // Always update source to 'user_click' so it's filtered from Pendientes
        // Also mark as read if not already
        const { db } = await import('../db');
        const { notifications } = await import('@shared/schema');
        const { eq } = await import('drizzle-orm');
        
        const [updated] = await db.update(notifications)
          .set({ 
            source: 'user_click',
            isRead: true,
            readAt: existing.isRead ? existing.readAt : new Date()
          })
          .where(eq(notifications.id, existing.id))
          .returning();
        
        return res.json({ success: true, notification: updated, action: 'updated_to_user_click' });
      }
      
      let priority: 'urgent' | 'high' | 'medium' = 'medium';
      let notificationType = 'due_soon';
      
      if (daysUntilDue < 0) {
        priority = 'urgent';
        notificationType = 'overdue';
      } else if (daysUntilDue === 0) {
        priority = 'high';
        notificationType = 'due_today';
      } else if (daysUntilDue <= 3) {
        priority = 'urgent';
      }
      
      const typeLabel = type === 'payable' ? 'pago' : 'cobro';
      
      let formattedAmount: string;
      try {
        const currencyCode = (currency || 'ARS').replace('_CASH', '');
        formattedAmount = new Intl.NumberFormat('es-AR', { 
          style: 'currency', 
          currency: currencyCode
        }).format(Number(amount));
      } catch {
        formattedAmount = `$${Number(amount).toLocaleString('es-AR')}`;
      }
      
      const notification = await storage.createNotification({
        userId: req.userId,
        organizationId,
        type: notificationType,
        priority,
        title: title || `${typeLabel} pendiente`,
        message: `${description} por ${formattedAmount}`,
        transactionId,
        source: 'user_click',
      });
      
      await storage.markNotificationRead(notification.id);
      
      res.json({ success: true, notification, action: 'created' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
}
