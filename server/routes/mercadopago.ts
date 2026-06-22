// =============================================================================
// AIKESTAR - Rutas de MercadoPago (planes, webhook, estado de suscripción)
// =============================================================================
import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { PLAN_DETAILS, PLAN_LABELS, PLAN_TYPES, type PlanType } from "@shared/schema";
import { getSubscription, getPayment, isMercadoPagoEnabled } from "../lib/mercadopago";
import { completePendingSignup } from "../lib/signupCompletion";

export function registerMercadoPagoRoutes(app: Express): void {
  // ── Planes disponibles (reemplaza a /api/stripe/products) ─────────────────
  // Público: lo consume la pantalla de registro para listar precios.
  app.get("/api/payments/plans", (_req: Request, res: Response) => {
    const plans = (PLAN_TYPES as readonly PlanType[]).map((planType) => ({
      planType,
      label: PLAN_LABELS[planType],
      price: PLAN_DETAILS[planType].price,
      currency: "ARS",
      maxOrgs: PLAN_DETAILS[planType].maxOrgs,
      maxMembersPerOrg: PLAN_DETAILS[planType].maxMembersPerOrg,
      isTeamPlan: PLAN_DETAILS[planType].isTeamPlan,
      features: PLAN_DETAILS[planType].features,
      highlight: PLAN_DETAILS[planType].highlight ?? null,
    }));
    res.json({ provider: "mercadopago", enabled: isMercadoPagoEnabled(), plans });
  });

  // ── Webhook de MercadoPago ────────────────────────────────────────────────
  // MP notifica acá cuando una suscripción cambia de estado o se cobra.
  // Anti-spoofing: NO confiamos en el body; re-consultamos el estado real a la
  // API de MP con nuestro Access Token antes de activar nada.
  app.post("/api/mercadopago/webhook", async (req: Request, res: Response) => {
    // Respondemos 200 rápido siempre (MP reintenta si no recibe 2xx).
    res.status(200).json({ received: true });

    try {
      // MP manda el tipo/id por body o por query, según la notificación.
      const type = (req.body?.type || req.body?.topic || req.query.type || req.query.topic) as string | undefined;
      const id = (req.body?.data?.id || req.query.id || req.query["data.id"]) as string | undefined;
      if (!type || !id) {
        console.log("[MP Webhook] Notificación sin type/id, ignorada");
        return;
      }
      console.log(`[MP Webhook] type=${type} id=${id}`);

      // Resolver el external_reference (= pendingSignupId) y el estado.
      let preapprovalId: string | undefined;
      let externalReference: string | undefined;
      let authorized = false;

      if (type.includes("preapproval")) {
        const sub = await getSubscription(String(id));
        preapprovalId = sub.id;
        externalReference = sub.externalReference;
        authorized = sub.status === "authorized";
      } else if (type.includes("payment")) {
        const payment = await getPayment(String(id));
        externalReference = (payment as any)?.external_reference;
        preapprovalId = (payment as any)?.metadata?.preapproval_id;
        const st = (payment as any)?.status;
        authorized = st === "approved" || st === "authorized";
      } else {
        console.log(`[MP Webhook] type no manejado: ${type}`);
        return;
      }

      if (!externalReference) {
        console.log("[MP Webhook] Sin external_reference, no se puede asociar al signup");
        return;
      }

      if (authorized) {
        const userId = await completePendingSignup(externalReference, {
          mpSubscriptionId: preapprovalId || String(id),
          status: "trialing",
        });
        console.log(`[MP Webhook] Alta completada para signup ${externalReference} → user ${userId}`);
      } else {
        console.log(`[MP Webhook] Suscripción aún no autorizada (signup ${externalReference})`);
      }
    } catch (err: any) {
      console.error("[MP Webhook] Error procesando notificación:", err?.message || err);
    }
  });

  // ── Estado de una suscripción (lo usa /payment-success para confirmar) ────
  // Permite que el front, al volver del checkout, verifique si ya quedó
  // autorizada (por si el webhook todavía no llegó) y dispare la activación.
  app.get("/api/mercadopago/subscription/:id", async (req: Request, res: Response) => {
    try {
      const sub = await getSubscription(req.params.id);
      // Si está autorizada, completamos el alta de forma idempotente.
      if (sub.status === "authorized" && sub.externalReference) {
        await completePendingSignup(sub.externalReference, {
          mpSubscriptionId: sub.id,
          status: "trialing",
        });
      }
      res.json({ status: sub.status, externalReference: sub.externalReference });
    } catch (err: any) {
      res.status(500).json({ message: "No se pudo consultar la suscripción" });
    }
  });
}
