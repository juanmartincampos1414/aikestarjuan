import { storage } from "../storage";
import { Transaction, Organization } from "@shared/schema";

export async function generateCommitmentNotifications(userId: string, organizationId: string): Promise<void> {
  const userOrgs = await storage.getOrganizationsByUser(userId);
  const userOrgIds = new Set(userOrgs.map((o: Organization) => o.id));
  
  if (!userOrgIds.has(organizationId)) {
    return;
  }

  const transactions = await storage.getTransactionsByOrganization(organizationId);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const pendingCommitments = transactions.filter(t => 
    (t.type === 'payable' || t.type === 'receivable') && 
    t.status === 'scheduled'
  );

  for (const commitment of pendingCommitments) {
    const dueDate = new Date(commitment.date);
    dueDate.setHours(0, 0, 0, 0);
    
    const daysUntilDue = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    
    const existingNotifications = await storage.getNotificationsByUser(userId, organizationId, true);
    const hasRecentNotification = existingNotifications.some(n => 
      n.transactionId === commitment.id && 
      n.createdAt && 
      (new Date().getTime() - new Date(n.createdAt).getTime()) < 24 * 60 * 60 * 1000
    );

    if (hasRecentNotification) continue;

    const typeLabel = commitment.type === 'payable' ? 'pago' : 'cobro';
    let formattedAmount: string;
    try {
      const currencyCode = (commitment.currency || 'ARS').replace('_CASH', '');
      formattedAmount = new Intl.NumberFormat('es-AR', { 
        style: 'currency', 
        currency: currencyCode
      }).format(Number(commitment.amount));
    } catch {
      formattedAmount = `$${Number(commitment.amount).toLocaleString('es-AR')}`;
    }

    if (daysUntilDue < 0) {
      const daysOverdue = Math.abs(daysUntilDue);
      await storage.createNotification({
        userId,
        organizationId,
        type: 'overdue',
        priority: 'urgent',
        title: `VENCIDO: ${typeLabel} pendiente`,
        message: `${commitment.description} por ${formattedAmount} venció hace ${daysOverdue} día(s)`,
        transactionId: commitment.id,
        source: 'auto',
      });
    } else if (daysUntilDue === 0) {
      await storage.createNotification({
        userId,
        organizationId,
        type: 'due_today',
        priority: 'high',
        title: `Vence HOY: ${typeLabel}`,
        message: `${commitment.description} por ${formattedAmount} vence hoy`,
        transactionId: commitment.id,
        source: 'auto',
      });
    } else if (daysUntilDue <= 5) {
      await storage.createNotification({
        userId,
        organizationId,
        type: 'due_soon',
        priority: daysUntilDue <= 2 ? 'high' : 'medium',
        title: `Próximo ${typeLabel}`,
        message: `${commitment.description} por ${formattedAmount} vence en ${daysUntilDue} día(s)`,
        transactionId: commitment.id,
        source: 'auto',
      });
    }
  }
}

export async function generateNotificationsForAllOrgs(userId: string): Promise<void> {
  const userOrgs = await storage.getOrganizationsByUser(userId);
  
  for (const org of userOrgs) {
    await generateCommitmentNotifications(userId, org.id);
  }
}

export async function generateDailyNotificationsForAllUsers(): Promise<{ usersProcessed: number; notificationsCreated: number }> {
  const allUsers = await storage.getAllUsers();
  let notificationsCreated = 0;
  
  for (const user of allUsers) {
    try {
    const userOrgs = await storage.getOrganizationsByUser(user.id);
    
    for (const org of userOrgs) {
      const transactions = await storage.getTransactionsByOrganization(org.id);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const pendingCommitments = transactions.filter(t => 
        (t.type === 'payable' || t.type === 'receivable') && 
        t.status === 'scheduled'
      );
      
      for (const commitment of pendingCommitments) {
        const dueDate = new Date(commitment.date);
        dueDate.setHours(0, 0, 0, 0);
        
        const daysUntilDue = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        
        if (daysUntilDue > 5) continue;
        
        const existingNotifications = await storage.getNotificationsByUser(user.id, org.id, true);
        const hasRecentNotification = existingNotifications.some(n => 
          n.transactionId === commitment.id && 
          n.createdAt && 
          (new Date().getTime() - new Date(n.createdAt).getTime()) < 24 * 60 * 60 * 1000
        );
        
        if (hasRecentNotification) continue;
        
        const typeLabel = commitment.type === 'payable' ? 'pago' : 'cobro';
        let formattedAmount: string;
        try {
          const currencyCode = (commitment.currency || 'ARS').replace('_CASH', '');
          formattedAmount = new Intl.NumberFormat('es-AR', { 
            style: 'currency', 
            currency: currencyCode
          }).format(Number(commitment.amount));
        } catch {
          formattedAmount = `$${Number(commitment.amount).toLocaleString('es-AR')}`;
        }
        
        let notification;
        if (daysUntilDue < 0) {
          const daysOverdue = Math.abs(daysUntilDue);
          notification = await storage.createNotification({
            userId: user.id,
            organizationId: org.id,
            type: 'overdue',
            priority: 'urgent',
            title: `VENCIDO: ${typeLabel} pendiente`,
            message: `${commitment.description} por ${formattedAmount} venció hace ${daysOverdue} día(s)`,
            transactionId: commitment.id,
            source: 'auto',
          });
        } else if (daysUntilDue === 0) {
          notification = await storage.createNotification({
            userId: user.id,
            organizationId: org.id,
            type: 'due_today',
            priority: 'high',
            title: `Vence HOY: ${typeLabel}`,
            message: `${commitment.description} por ${formattedAmount} vence hoy`,
            transactionId: commitment.id,
            source: 'auto',
          });
        } else {
          notification = await storage.createNotification({
            userId: user.id,
            organizationId: org.id,
            type: 'due_soon',
            priority: daysUntilDue <= 2 ? 'high' : 'medium',
            title: `Próximo ${typeLabel}`,
            message: `${commitment.description} por ${formattedAmount} vence en ${daysUntilDue} día(s)`,
            transactionId: commitment.id,
            source: 'auto',
          });
        }
        
        if (notification) notificationsCreated++;
      }
    }
    } catch (err: any) {
      console.error(`[Notifications] Error processing user ${user.id}:`, err.message);
    }
  }
  
  return { usersProcessed: allUsers.length, notificationsCreated };
}
