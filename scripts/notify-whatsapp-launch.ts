import { db } from "../server/db";
import { users, organizations, memberships, notifications } from "../shared/schema";
import { eq, and } from "drizzle-orm";

const WHATSAPP_NUMBER = "+54 11 2489-4944";

async function sendWhatsAppLaunchNotification(): Promise<void> {
  console.log("[WhatsApp Launch Notification] Starting...");
  
  const allUsers = await db.select().from(users);
  console.log(`[WhatsApp Launch Notification] Found ${allUsers.length} users`);
  
  let notificationsCreated = 0;
  
  for (const user of allUsers) {
    const userOrgs = await db
      .select({
        id: organizations.id,
        name: organizations.name,
      })
      .from(organizations)
      .innerJoin(memberships, eq(memberships.organizationId, organizations.id))
      .where(eq(memberships.userId, user.id));
    
    for (const org of userOrgs) {
      const existingNotification = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, user.id),
            eq(notifications.organizationId, org.id),
            eq(notifications.type, "whatsapp_launch")
          )
        );
      
      if (existingNotification.length > 0) {
        console.log(`[WhatsApp Launch] Skipping ${user.email} (${org.name}) - already notified`);
        continue;
      }
      
      await db.insert(notifications).values({
        userId: user.id,
        organizationId: org.id,
        type: "whatsapp_launch",
        priority: "high",
        title: "¡Nuevo! Registrá movimientos por WhatsApp",
        message: `Primero vinculá tu número de teléfono en Perfil. Después escribí a ${WHATSAPP_NUMBER} para registrar ingresos, gastos y consultar tus finanzas.`,
        transactionId: null,
        isRead: false,
        readAt: null,
        source: "auto",
      });
      
      notificationsCreated++;
      console.log(`[WhatsApp Launch] Notification created for ${user.email} (${org.name})`);
    }
  }
  
  console.log(`[WhatsApp Launch Notification] Complete! Created ${notificationsCreated} notifications`);
}

sendWhatsAppLaunchNotification()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[WhatsApp Launch Notification] Error:", error);
    process.exit(1);
  });
