// SendGrid Email Service for Aikestar
// Integration: SendGrid connection via Replit connectors
// WARNING: Never cache the client - create a fresh instance each time per connector guidelines

import { MailService } from '@sendgrid/mail';

// Get the base URL for the app
export function getAppBaseUrl(): string {
  // In development, use the dev domain for testing
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (devDomain && process.env.NODE_ENV === 'development') {
    return `https://${devDomain}`;
  }

  // URL pública de la app (los links de los emails apuntan acá). Configurable
  // por APP_BASE_URL; si no, deriva de APP_DOMAIN; por último, aikestar.net.
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const domain = process.env.APP_DOMAIN?.replace(/^\./, '');
  if (domain) return `https://${domain}`;
  return 'https://aikestar.net';
}

async function getCredentials() {
  // First try manual environment variables (for production fallback)
  const manualApiKey = process.env.SENDGRID_API_KEY;
  const manualFromEmail = process.env.SENDGRID_FROM_EMAIL;
  
  if (manualApiKey && manualFromEmail) {
    console.log('[Email] Using manual SendGrid credentials from environment variables');
    return { apiKey: manualApiKey, email: manualFromEmail };
  }
  
  // Try Replit connector
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  
  console.log('[Email] Getting credentials - hostname:', hostname ? 'present' : 'missing');
  console.log('[Email] REPL_IDENTITY:', process.env.REPL_IDENTITY ? 'present' : 'missing');
  console.log('[Email] WEB_REPL_RENEWAL:', process.env.WEB_REPL_RENEWAL ? 'present' : 'missing');
  console.log('[Email] NODE_ENV:', process.env.NODE_ENV);
  
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!hostname) {
    console.error('[Email] ERROR: REPLIT_CONNECTORS_HOSTNAME not set and no manual credentials');
    throw new Error('REPLIT_CONNECTORS_HOSTNAME not set - SendGrid connector may not be available. Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL as fallback.');
  }

  if (!xReplitToken) {
    console.error('[Email] ERROR: No authentication token available and no manual credentials');
    throw new Error('X_REPLIT_TOKEN not found for repl/depl. Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL as fallback.');
  }

  try {
    const url = 'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=sendgrid';
    console.log('[Email] Fetching connector settings...');
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Email] Connector API error:', response.status, errorText);
      throw new Error(`Connector API returned ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    const connectionSettings = data.items?.[0];
    
    if (!connectionSettings) {
      console.error('[Email] No SendGrid connection found in response:', JSON.stringify(data));
      throw new Error('SendGrid connector not configured - please connect SendGrid in Replit or set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL');
    }
    
    if (!connectionSettings.settings?.api_key || !connectionSettings.settings?.from_email) {
      console.error('[Email] SendGrid connection missing required settings');
      throw new Error('SendGrid API key or from_email not configured');
    }
    
    console.log('[Email] Credentials obtained successfully via connector, from:', connectionSettings.settings.from_email);
    return {apiKey: connectionSettings.settings.api_key, email: connectionSettings.settings.from_email};
  } catch (error: any) {
    console.error('[Email] Failed to get SendGrid credentials:', error.message);
    throw error;
  }
}

// Creates a fresh SendGrid client instance on every call
// This ensures credential rotation works properly
async function getUncachableSendGridClient() {
  const {apiKey, email} = await getCredentials();
  const client = new MailService();
  client.setApiKey(apiKey);
  return {
    client,
    fromEmail: email
  };
}

// Email templates with Aikestar branding
function getEmailTemplate(content: string, title: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0f172a; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px; border: 1px solid #334155; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; border-bottom: 1px solid #334155;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; background: linear-gradient(135deg, #22d3ee 0%, #ec4899 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">
                Aikestar
              </h1>
              <p style="margin: 8px 0 0; color: #94a3b8; font-size: 14px;">
                Sistema de Gestión Administrativa e Inteligente
              </p>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 40px; color: #e2e8f0;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 40px 40px; text-align: center; border-top: 1px solid #334155;">
              <p style="margin: 0; color: #64748b; font-size: 12px;">
                Este email fue enviado desde <a href="${getAppBaseUrl()}" style="color: #22d3ee; text-decoration: none;">Aikestar</a>
              </p>
              <p style="margin: 8px 0 0; color: #475569; font-size: 11px;">
                Si no solicitaste este email, puedes ignorarlo.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// Welcome email for new account
export async function sendWelcomeEmail(userEmail: string, userName: string): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    
    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        ¡Bienvenido/a a Aikestar, ${userName}!
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Tu cuenta ha sido creada exitosamente. Ahora puedes comenzar a gestionar las finanzas de tu organización con el poder de la inteligencia artificial.
      </p>
      <p style="margin: 0 0 24px; line-height: 1.6; color: #cbd5e1;">
        Con Aikestar podrás:
      </p>
      <ul style="margin: 0 0 24px; padding-left: 20px; color: #cbd5e1; line-height: 1.8;">
        <li>Registrar ingresos y gastos fácilmente</li>
        <li>Analizar tu salud financiera con IA</li>
        <li>Generar reportes profesionales</li>
        <li>Gestionar múltiples organizaciones</li>
      </ul>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${getAppBaseUrl()}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Ir a Aikestar
        </a>
      </div>
      <p style="margin: 0; color: #94a3b8; font-size: 14px;">
        ¡Gracias por elegir Aikestar!
      </p>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar Soporte' },
      subject: '¡Bienvenido/a a Aikestar!',
      html: getEmailTemplate(content, 'Bienvenido a Aikestar'),
    });

    console.log(`[Email] Welcome email sent to ${userEmail}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send welcome email:', error);
    return false;
  }
}

// Password change confirmation email
export async function sendPasswordChangeEmail(userEmail: string, userName: string): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    
    const changeDate = new Date().toLocaleString('es-AR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        Contraseña actualizada
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola ${userName},
      </p>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Te confirmamos que tu contraseña de Aikestar fue cambiada exitosamente.
      </p>
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0; color: #94a3b8; font-size: 14px;">
          <strong style="color: #e2e8f0;">Fecha del cambio:</strong> ${changeDate}
        </p>
      </div>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #f87171;">
        <strong>⚠️ Si no realizaste este cambio, contactanos inmediatamente.</strong>
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="mailto:soporte@aikestar.net" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #ec4899 0%, #be185d 100%); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Contactar Soporte
        </a>
      </div>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar Seguridad' },
      subject: 'Tu contraseña de Aikestar fue actualizada',
      html: getEmailTemplate(content, 'Contraseña Actualizada'),
    });

    console.log(`[Email] Password change email sent to ${userEmail}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send password change email:', error);
    return false;
  }
}

// Subscription confirmation email
export async function sendSubscriptionEmail(
  userEmail: string, 
  userName: string, 
  planName: string,
  planType: 'personal' | 'business'
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    
    const planColor = planType === 'personal' ? '#22d3ee' : '#a855f7';
    const planGradient = planType === 'personal' 
      ? 'linear-gradient(135deg, #22d3ee 0%, #0891b2 100%)'
      : 'linear-gradient(135deg, #a855f7 0%, #7c3aed 100%)';

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        ¡Suscripción activada!
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola ${userName},
      </p>
      <p style="margin: 0 0 24px; line-height: 1.6; color: #cbd5e1;">
        Tu suscripción al plan <strong style="color: ${planColor};">${planName}</strong> ha sido activada exitosamente.
      </p>
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: center;">
        <div style="display: inline-block; padding: 8px 24px; background: ${planGradient}; border-radius: 20px; margin-bottom: 16px;">
          <span style="color: ${planType === 'personal' ? '#0f172a' : 'white'}; font-weight: 600; font-size: 14px; text-transform: uppercase;">
            Plan ${planType === 'personal' ? 'Personal' : 'Empresa'}
          </span>
        </div>
        <h3 style="margin: 0 0 8px; color: #f1f5f9; font-size: 24px;">
          ${planName}
        </h3>
        <p style="margin: 0; color: #94a3b8; font-size: 14px;">
          Activo desde hoy
        </p>
      </div>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Ahora tenés acceso a todas las funcionalidades de tu plan. Podés gestionar tu suscripción desde la sección de configuración de tu cuenta.
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${getAppBaseUrl()}" style="display: inline-block; padding: 14px 32px; background: ${planGradient}; color: ${planType === 'personal' ? '#0f172a' : 'white'}; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Ir a mi cuenta
        </a>
      </div>
      <p style="margin: 0; color: #94a3b8; font-size: 14px;">
        ¿Tenés preguntas? Escribinos a <a href="mailto:soporte@aikestar.net" style="color: #22d3ee;">soporte@aikestar.net</a>
      </p>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: `¡Tu plan ${planName} está activo!`,
      html: getEmailTemplate(content, 'Suscripción Activada'),
    });

    console.log(`[Email] Subscription email sent to ${userEmail} for plan ${planName}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send subscription email:', error);
    return false;
  }
}

// Team invitation email
export async function sendTeamInvitationEmail(
  userEmail: string,
  organizationName: string,
  inviterName: string,
  temporaryPassword: string
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        Invitación a ${organizationName}
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        ${inviterName} te ha invitado a unirte a <strong style="color: #22d3ee;">${organizationName}</strong> en Aikestar.
      </p>
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="margin: 0 0 12px; color: #94a3b8; font-size: 14px;">
          <strong style="color: #e2e8f0;">Tu contraseña temporal:</strong>
        </p>
        <p style="margin: 0; font-family: monospace; font-size: 20px; color: #22d3ee; letter-spacing: 2px;">
          ${temporaryPassword}
        </p>
      </div>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Usá tu email y esta contraseña para iniciar sesión. Te pediremos que la cambies en tu primer ingreso.
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${getAppBaseUrl()}/login" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Iniciar Sesión
        </a>
      </div>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: `${inviterName} te invitó a ${organizationName}`,
      html: getEmailTemplate(content, 'Invitación de Equipo'),
    });

    console.log(`[Email] Team invitation sent to ${userEmail} for org ${organizationName}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send team invitation email:', error);
    return false;
  }
}

export async function sendTeamAddedEmail(
  userEmail: string,
  userName: string,
  organizationName: string,
  inviterName: string
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        Te agregaron a ${organizationName}
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        ¡Hola${userName ? ` ${userName}` : ''}! <strong style="color: #22d3ee;">${inviterName}</strong> te agregó al equipo de <strong style="color: #22d3ee;">${organizationName}</strong> en Aikestar.
      </p>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Ya podés acceder a la organización desde tu cuenta. Entrá a Aikestar y seleccionala desde el menú de organizaciones.
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${getAppBaseUrl()}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Ir a Aikestar
        </a>
      </div>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: `${inviterName} te agregó a ${organizationName}`,
      html: getEmailTemplate(content, 'Te agregaron a un equipo'),
    });

    console.log(`[Email] Team added notification sent to ${userEmail} for org ${organizationName}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send team added email:', error);
    return false;
  }
}

// Password reset email
export async function sendPasswordResetEmail(
  userEmail: string,
  userName: string,
  resetToken: string
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();

    const baseUrl = getAppBaseUrl();
    // Use the redirect endpoint which stores params in localStorage for reliable access
    const resetLink = `${baseUrl}/api/auth/reset-redirect?email=${encodeURIComponent(userEmail)}&token=${resetToken}`;
    console.log('[Email] Password reset link generated:', resetLink);

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        Recuperar contraseña
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola ${userName},
      </p>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Recibimos una solicitud para restablecer la contraseña de tu cuenta en Aikestar.
      </p>
      <p style="margin: 0 0 24px; line-height: 1.6; color: #cbd5e1;">
        Hacé clic en el botón de abajo para crear una nueva contraseña:
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${resetLink}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Restablecer Contraseña
        </a>
      </div>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #94a3b8; font-size: 14px;">
        Este enlace expira en <strong>1 hora</strong>.
      </p>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #f87171;">
        <strong>⚠️ Si no solicitaste este cambio, podés ignorar este email.</strong>
      </p>
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0; color: #64748b; font-size: 12px;">
          Si el botón no funciona, copiá y pegá este enlace en tu navegador:<br>
          <a href="${resetLink}" style="color: #22d3ee; word-break: break-all;">${resetLink}</a>
        </p>
      </div>
    `;

    console.log('[Email] Attempting to send password reset email to:', userEmail, 'from:', fromEmail);
    
    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar Seguridad' },
      subject: 'Restablecer contraseña de Aikestar',
      html: getEmailTemplate(content, 'Recuperar Contraseña'),
    });

    console.log(`[Email] Password reset email sent successfully to ${userEmail}`);
    return true;
  } catch (error: any) {
    console.error('[Email] Failed to send password reset email:', error);
    // Log SendGrid specific error details
    if (error.response) {
      console.error('[Email] SendGrid response status:', error.response.statusCode);
      console.error('[Email] SendGrid response body:', JSON.stringify(error.response.body));
    }
    if (error.code) {
      console.error('[Email] Error code:', error.code);
    }
    return false;
  }
}

// Task #225 — Email transaccional de confirmación que se dispara cuando el
// usuario verifica con éxito un código de WhatsApp y queda vinculado.
// Funciona como tripwire de seguridad: si alguien con acceso a la cuenta
// vincula un número que no es del dueño legítimo, el dueño se entera por
// email y puede contactar a soporte.
export async function sendPhoneLinkedConfirmationEmail(
  userEmail: string,
  userName: string,
  maskedPhone: string,
  linkedAt: Date = new Date(),
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();

    const fechaLegible = linkedAt.toLocaleString('es-AR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Argentina/Buenos_Aires',
    });

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        Vinculaste tu WhatsApp a Aikestar
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola ${userName},
      </p>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Confirmamos que vinculaste un número de WhatsApp a tu cuenta de Aikestar.
        A partir de ahora podés registrar movimientos escribiéndole al bot directamente desde tu WhatsApp.
      </p>
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0 0 8px; color: #94a3b8; font-size: 13px;">
          Número vinculado
        </p>
        <p style="margin: 0 0 12px; color: #f1f5f9; font-size: 18px; font-weight: 600;">
          ${maskedPhone}
        </p>
        <p style="margin: 0 0 8px; color: #94a3b8; font-size: 13px;">
          Fecha
        </p>
        <p style="margin: 0; color: #f1f5f9; font-size: 14px;">
          ${fechaLegible}
        </p>
      </div>
      <div style="background: #1e1b3b; border: 1px solid #6366f1; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0 0 8px; color: #f1f5f9; font-size: 14px; font-weight: 600;">
          ¿No fuiste vos?
        </p>
        <p style="margin: 0; line-height: 1.6; color: #cbd5e1; font-size: 14px;">
          Si no reconocés esta vinculación, alguien podría tener acceso a tu cuenta.
          Cambiá tu contraseña ahora y escribinos a soporte para ayudarte.
        </p>
      </div>
      <p style="margin: 24px 0 0; line-height: 1.6; color: #94a3b8; font-size: 14px;">
        ¡Gracias por usar Aikestar!
      </p>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar Seguridad' },
      subject: 'Vinculaste tu WhatsApp a Aikestar',
      html: getEmailTemplate(content, 'WhatsApp vinculado'),
    });

    console.log(`[Email] Phone linked confirmation sent to ${userEmail}`);
    return true;
  } catch (error: any) {
    console.error('[Email] Failed to send phone linked confirmation:', error);
    if (error.response) {
      console.error('[Email] SendGrid response status:', error.response.statusCode);
      console.error('[Email] SendGrid response body:', JSON.stringify(error.response.body));
    }
    return false;
  }
}

// Subscription renewal confirmation email (combined with receipt when payment data provided)
export async function sendRenewalEmail(
  userEmail: string, 
  userName: string, 
  planName: string,
  receipt?: {
    amountPaid: number;
    currency: string;
    invoiceId: string;
    invoiceUrl?: string;
  }
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    
    const renewalDate = new Date().toLocaleString('es-AR', {
      dateStyle: 'long',
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    const paymentDate = new Date().toLocaleString('es-AR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    let formattedAmount = '';
    if (receipt) {
      try {
        const currencyCode = receipt.currency.toUpperCase().replace('_CASH', '');
        formattedAmount = new Intl.NumberFormat('es-AR', {
          style: 'currency',
          currency: currencyCode,
          minimumFractionDigits: 2,
        }).format(receipt.amountPaid / 100);
      } catch {
        formattedAmount = `$${(receipt.amountPaid / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
      }
    }

    const receiptSection = receipt ? `
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; margin: 24px 0;">
        <h3 style="margin: 0 0 16px; color: #f1f5f9; font-size: 16px;">Detalle del pago</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px;">Plan</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px; text-align: right; font-weight: 600;">${planName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px;">Fecha de pago</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px; text-align: right;">${paymentDate}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px;">N° de referencia</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px; text-align: right; font-family: monospace;">${receipt.invoiceId}</td>
          </tr>
          <tr style="border-top: 1px solid #334155;">
            <td style="padding: 16px 0 8px; color: #f1f5f9; font-size: 16px; font-weight: 600;">Total pagado</td>
            <td style="padding: 16px 0 8px; color: #22d3ee; font-size: 20px; text-align: right; font-weight: 700;">${formattedAmount}</td>
          </tr>
        </table>
      </div>
      ${receipt.invoiceUrl ? `
      <div style="text-align: center; margin: 24px 0 8px;">
        <a href="${receipt.invoiceUrl}" style="color: #22d3ee; text-decoration: underline; font-size: 14px;">
          Ver factura completa
        </a>
      </div>
      ` : ''}
    ` : `
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0; color: #94a3b8; font-size: 14px;">
          <strong style="color: #e2e8f0;">Fecha de renovación:</strong> ${renewalDate}
        </p>
      </div>
    `;

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        ¡Suscripción renovada!
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola ${userName},
      </p>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Tu suscripción al plan <strong style="color: #22d3ee;">${planName}</strong> fue renovada exitosamente.
      </p>
      ${receiptSection}
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Gracias por continuar confiando en Aikestar. Seguí gestionando tus finanzas de manera inteligente.
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${getAppBaseUrl()}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Ir a Aikestar
        </a>
      </div>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: `Tu plan ${planName} fue renovado`,
      html: getEmailTemplate(content, 'Suscripción Renovada'),
    });

    console.log(`[Email] Renewal email sent to ${userEmail}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send renewal email:', error);
    return false;
  }
}

// Payment failed email
export async function sendPaymentFailedEmail(
  userEmail: string, 
  userName: string, 
  planName: string,
  paymentFailedAt?: Date
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    
    // Task #340 — Sólo informamos sobre el bloqueo de acceso, que SÍ ocurre
    // a los 7 días del fallo. NO prometemos eliminación: el cron de borrado
    // sólo toca cuentas con `cancellationStatus='cancelled'` y 60 días post
    // expiración del período (ver server/services/cancelledAccountCleanup.ts).
    // Las cuentas en `past_due` puro nunca son borradas por ningún cron, así
    // que el copy anterior ("eliminada en X días") era engañoso.
    const GRACE_DAYS = 7;
    let daysUntilBlocked = GRACE_DAYS;
    let alreadyBlocked = false;

    if (paymentFailedAt) {
      const now = new Date();
      const daysSinceFailure = Math.floor((now.getTime() - paymentFailedAt.getTime()) / (1000 * 60 * 60 * 24));
      daysUntilBlocked = Math.max(0, GRACE_DAYS - daysSinceFailure);
      alreadyBlocked = daysSinceFailure >= GRACE_DAYS;
    }

    const content = `
      <h2 style="margin: 0 0 20px; color: #f87171; font-size: 22px;">
        ⚠️ Problema con tu pago
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola ${userName},
      </p>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        No pudimos procesar el pago de tu suscripción al plan <strong style="color: #22d3ee;">${planName}</strong>.
      </p>
      <div style="background: #1e293b; border: 1px solid #f87171; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0 0 8px; color: #f87171; font-size: 14px; font-weight: 600;">
          ${alreadyBlocked ? '⛔ Estado de tu cuenta:' : '⏰ Tiempo restante:'}
        </p>
        <ul style="margin: 0; padding-left: 20px; color: #cbd5e1; font-size: 14px; line-height: 1.8;">
          ${alreadyBlocked
            ? `<li style="color: #f87171;"><strong>Tu acceso está bloqueado.</strong> Regularizá el pago para recuperarlo.</li>`
            : `<li>Tu acceso será bloqueado en <strong style="color: #fbbf24;">${daysUntilBlocked} ${daysUntilBlocked === 1 ? 'día' : 'días'}</strong> si no regularizás el pago.</li>`
          }
          <li>Tus datos siguen guardados y no se eliminan. En cuanto actualices el método de pago, recuperás el acceso.</li>
        </ul>
      </div>
      <div style="background: #1e293b; border: 1px solid #475569; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0 0 8px; color: #94a3b8; font-size: 14px; font-weight: 600;">
          Posibles causas del fallo:
        </p>
        <ul style="margin: 0; padding-left: 20px; color: #cbd5e1; font-size: 14px; line-height: 1.8;">
          <li>Fondos insuficientes</li>
          <li>Tarjeta vencida o bloqueada</li>
          <li>Límite de crédito alcanzado</li>
        </ul>
      </div>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Por favor, actualizá tu método de pago lo antes posible para mantener tu cuenta activa.
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${getAppBaseUrl()}/settings?tab=plan" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #f87171 0%, #dc2626 100%); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Actualizar Método de Pago
        </a>
      </div>
      <p style="margin: 0; color: #94a3b8; font-size: 14px;">
        ¿Necesitás ayuda? Escribinos a <a href="mailto:soporte@aikestar.net" style="color: #22d3ee;">soporte@aikestar.net</a>
      </p>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: '⚠️ Problema con tu pago de Aikestar',
      html: getEmailTemplate(content, 'Problema de Pago'),
    });

    console.log(`[Email] Payment failed email sent to ${userEmail}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send payment failed email:', error);
    return false;
  }
}

export async function sendInactiveAccountReminderEmail(
  userEmail: string,
  userName: string,
  daysRemaining: number
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();

    const content = `
      <h2 style="margin: 0 0 20px; color: #22d3ee; font-size: 22px;">
        Tu cuenta en Aikestar te está esperando
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola ${userName},
      </p>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Vimos que creaste tu cuenta en Aikestar pero todavía no elegiste un plan. Queríamos recordarte que tenés todo listo para empezar a gestionar tus finanzas de forma inteligente.
      </p>
      <div style="background: #1e293b; border: 1px solid #475569; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0 0 12px; color: #94a3b8; font-size: 14px; font-weight: 600;">
          Con Aikestar podés:
        </p>
        <ul style="margin: 0; padding-left: 20px; color: #cbd5e1; font-size: 14px; line-height: 2;">
          <li>Controlar todos tus ingresos y egresos en un solo lugar</li>
          <li>Generar reportes inteligentes con IA</li>
          <li>Gestionar clientes, proveedores y stock</li>
          <li>Trabajar con múltiples monedas y cotizaciones</li>
        </ul>
      </div>
      <div style="background: #1e293b; border: 1px solid #fbbf24; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0; color: #fbbf24; font-size: 14px;">
          <strong>Importante:</strong> Tu cuenta será eliminada automáticamente en <strong>${daysRemaining} días</strong> si no activás una suscripción.
        </p>
      </div>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${getAppBaseUrl()}/pricing" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Elegir mi Plan
        </a>
      </div>
      <p style="margin: 0; color: #94a3b8; font-size: 14px;">
        ¿Tenés dudas? Escribinos a <a href="mailto:soporte@aikestar.net" style="color: #22d3ee;">soporte@aikestar.net</a>
      </p>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: 'Tu cuenta en Aikestar te está esperando',
      html: getEmailTemplate(content, 'Recordatorio'),
    });

    console.log(`[Email] Inactive account reminder sent to ${userEmail}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send inactive account reminder:', error);
    return false;
  }
}

// Subscription cancellation email
export async function sendCancellationEmail(
  userEmail: string, 
  userName: string, 
  planName: string,
  accessEndsAt?: string | null
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    
    const cancelDate = new Date().toLocaleString('es-AR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    const accessEndFormatted = accessEndsAt
      ? new Date(accessEndsAt).toLocaleDateString('es-AR', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          timeZone: 'America/Argentina/Buenos_Aires'
        })
      : null;

    const accessEndSection = accessEndFormatted
      ? `
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0 0 8px; color: #94a3b8; font-size: 14px;">
          <strong style="color: #e2e8f0;">Fecha de solicitud:</strong> ${cancelDate}
        </p>
        <p style="margin: 0; color: #94a3b8; font-size: 14px;">
          <strong style="color: #e2e8f0;">Acceso hasta:</strong> <span style="color: #fbbf24;">${accessEndFormatted}</span>
        </p>
      </div>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Seguirás teniendo acceso completo hasta esa fecha. Después, tu cuenta quedará inactiva pero tus datos se conservarán por 60 días. Durante ese tiempo podés volver a suscribirte y recuperar todo.
      </p>
      `
      : `
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0; color: #94a3b8; font-size: 14px;">
          <strong style="color: #e2e8f0;">Fecha de cancelación:</strong> ${cancelDate}
        </p>
      </div>
      `;

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        Suscripción cancelada
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola ${userName},
      </p>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Te confirmamos que tu suscripción al plan <strong style="color: #f87171;">${planName}</strong> ha sido cancelada.
      </p>
      ${accessEndSection}
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Si cambiás de opinión, podés reactivar tu suscripción en cualquier momento antes de que se cancele definitivamente.
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${getAppBaseUrl()}/settings?tab=plan" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Reactivar suscripción
        </a>
      </div>
      <p style="margin: 0; color: #94a3b8; font-size: 14px;">
        ¿Tenés preguntas o comentarios? Escribinos a <a href="mailto:soporte@aikestar.net" style="color: #22d3ee;">soporte@aikestar.net</a>
      </p>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: accessEndFormatted 
        ? `Tu suscripción se cancela el ${accessEndFormatted}`
        : 'Tu suscripción ha sido cancelada',
      html: getEmailTemplate(content, 'Suscripción Cancelada'),
    });

    console.log(`[Email] Cancellation email sent to ${userEmail}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send cancellation email:', error);
    return false;
  }
}

export async function sendReactivationEmail(
  userEmail: string,
  userName: string,
  planName: string
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();

    const reactivationDate = new Date().toLocaleString('es-AR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        ¡Suscripción reactivada!
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola ${userName},
      </p>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Tu suscripción al plan <strong style="color: #22d3ee;">${planName}</strong> fue reactivada exitosamente. La cancelación fue revertida y tu cuenta seguirá activa con normalidad.
      </p>
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0; color: #94a3b8; font-size: 14px;">
          <strong style="color: #e2e8f0;">Fecha de reactivación:</strong> ${reactivationDate}
        </p>
      </div>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Gracias por continuar confiando en Aikestar. Todos tus datos y configuraciones se mantienen intactos.
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${getAppBaseUrl()}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Ir a Aikestar
        </a>
      </div>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: `Tu plan ${planName} fue reactivado`,
      html: getEmailTemplate(content, 'Suscripción Reactivada'),
    });

    console.log(`[Email] Reactivation email sent to ${userEmail}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send reactivation email:', error);
    return false;
  }
}

// Payment receipt email
export async function sendPaymentReceiptEmail(
  userEmail: string, 
  userName: string, 
  planName: string,
  amountPaid: number,
  currency: string,
  invoiceId: string,
  invoiceUrl?: string
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    
    const paymentDate = new Date().toLocaleString('es-AR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    // Format amount (Stripe sends amount in cents)
    let formattedAmount: string;
    try {
      const currencyCode = currency.toUpperCase().replace('_CASH', '');
      formattedAmount = new Intl.NumberFormat('es-AR', {
        style: 'currency',
        currency: currencyCode,
        minimumFractionDigits: 2,
      }).format(amountPaid / 100);
    } catch {
      formattedAmount = `$${(amountPaid / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
    }

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        Recibo de Pago
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola ${userName},
      </p>
      <p style="margin: 0 0 24px; line-height: 1.6; color: #cbd5e1;">
        Te confirmamos que recibimos tu pago correctamente. A continuación, los detalles:
      </p>
      
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; margin: 24px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px;">Plan</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px; text-align: right; font-weight: 600;">${planName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px;">Fecha de pago</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px; text-align: right;">${paymentDate}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px;">N° de referencia</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px; text-align: right; font-family: monospace;">${invoiceId}</td>
          </tr>
          <tr style="border-top: 1px solid #334155;">
            <td style="padding: 16px 0 8px; color: #f1f5f9; font-size: 16px; font-weight: 600;">Total pagado</td>
            <td style="padding: 16px 0 8px; color: #22d3ee; font-size: 20px; text-align: right; font-weight: 700;">${formattedAmount}</td>
          </tr>
        </table>
      </div>
      
      ${invoiceUrl ? `
      <div style="text-align: center; margin: 32px 0;">
        <a href="${invoiceUrl}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Ver Factura Completa
        </a>
      </div>
      ` : ''}
      
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Gracias por confiar en Aikestar para gestionar tus finanzas.
      </p>
      <p style="margin: 0; color: #94a3b8; font-size: 14px;">
        ¿Tenés preguntas? Escribinos a <a href="mailto:soporte@aikestar.net" style="color: #22d3ee;">soporte@aikestar.net</a>
      </p>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: `Recibo de pago - ${planName}`,
      html: getEmailTemplate(content, 'Recibo de Pago'),
    });

    console.log(`[Email] Payment receipt sent to ${userEmail} for ${formattedAmount}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send payment receipt email:', error);
    return false;
  }
}

// Plan change notification email
export async function sendPlanChangeEmail(
  userEmail: string, 
  userName: string, 
  oldPlanName: string,
  newPlanName: string,
  isUpgrade: boolean
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    
    const changeDate = new Date().toLocaleString('es-AR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    const changeColor = isUpgrade ? '#22d3ee' : '#f59e0b';
    const changeGradient = isUpgrade 
      ? 'linear-gradient(135deg, #22d3ee 0%, #0891b2 100%)'
      : 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
    const changeType = isUpgrade ? 'Mejora de plan' : 'Cambio de plan';
    const changeIcon = isUpgrade ? '🚀' : '📋';

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        ${changeIcon} ${changeType}
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola ${userName},
      </p>
      <p style="margin: 0 0 24px; line-height: 1.6; color: #cbd5e1;">
        Te confirmamos que tu plan de suscripción ha sido ${isUpgrade ? 'mejorado' : 'modificado'} exitosamente.
      </p>
      
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; margin: 24px 0;">
        <div style="display: flex; align-items: center; justify-content: center; gap: 16px;">
          <div style="text-align: center;">
            <p style="margin: 0 0 8px; color: #94a3b8; font-size: 12px; text-transform: uppercase;">Plan anterior</p>
            <p style="margin: 0; color: #64748b; font-size: 16px; text-decoration: line-through;">${oldPlanName}</p>
          </div>
          <div style="color: ${changeColor}; font-size: 24px;">→</div>
          <div style="text-align: center;">
            <p style="margin: 0 0 8px; color: #94a3b8; font-size: 12px; text-transform: uppercase;">Nuevo plan</p>
            <p style="margin: 0; color: ${changeColor}; font-size: 18px; font-weight: 700;">${newPlanName}</p>
          </div>
        </div>
        <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #334155; text-align: center;">
          <p style="margin: 0; color: #94a3b8; font-size: 14px;">
            Fecha del cambio: <strong style="color: #e2e8f0;">${changeDate}</strong>
          </p>
        </div>
      </div>
      
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        ${isUpgrade 
          ? 'Ya tenés acceso a todas las nuevas funcionalidades de tu plan mejorado.' 
          : 'Tu nuevo plan está activo. Las funcionalidades se ajustarán de acuerdo a tu nueva suscripción.'}
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${getAppBaseUrl()}/settings?tab=plan" style="display: inline-block; padding: 14px 32px; background: ${changeGradient}; color: ${isUpgrade ? '#0f172a' : 'white'}; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Ver mi suscripción
        </a>
      </div>
      <p style="margin: 0; color: #94a3b8; font-size: 14px;">
        ¿Tenés preguntas? Escribinos a <a href="mailto:soporte@aikestar.net" style="color: #22d3ee;">soporte@aikestar.net</a>
      </p>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: `${changeIcon} Tu plan cambió a ${newPlanName}`,
      html: getEmailTemplate(content, changeType),
    });

    console.log(`[Email] Plan change email sent to ${userEmail}: ${oldPlanName} -> ${newPlanName}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send plan change email:', error);
    return false;
  }
}

// Support contact email
export async function sendSupportEmail(
  userEmail: string,
  userName: string,
  subject: string,
  message: string,
  organizationName?: string,
  replyToEmail?: string
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    
    const submittedAt = new Date().toLocaleString('es-AR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    // Use replyToEmail if provided and different from userEmail
    const effectiveReplyTo = replyToEmail || userEmail;
    const showAlternateEmail = replyToEmail && replyToEmail !== userEmail;

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        Nuevo mensaje de soporte
      </h2>
      
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="margin: 0 0 12px; color: #94a3b8; font-size: 14px;">
          <strong style="color: #e2e8f0;">De:</strong> ${userName} (${userEmail})
        </p>
        ${showAlternateEmail ? `
        <p style="margin: 0 0 12px; color: #94a3b8; font-size: 14px;">
          <strong style="color: #e2e8f0;">Responder a:</strong> ${effectiveReplyTo}
        </p>
        ` : ''}
        ${organizationName ? `
        <p style="margin: 0 0 12px; color: #94a3b8; font-size: 14px;">
          <strong style="color: #e2e8f0;">Organización:</strong> ${organizationName}
        </p>
        ` : ''}
        <p style="margin: 0 0 12px; color: #94a3b8; font-size: 14px;">
          <strong style="color: #e2e8f0;">Asunto:</strong> ${subject}
        </p>
        <p style="margin: 0; color: #94a3b8; font-size: 14px;">
          <strong style="color: #e2e8f0;">Fecha:</strong> ${submittedAt}
        </p>
      </div>
      
      <div style="background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <p style="margin: 0 0 8px; color: #22d3ee; font-size: 14px; font-weight: 600;">
          Mensaje:
        </p>
        <p style="margin: 0; color: #e2e8f0; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">
${message}
        </p>
      </div>
      
      <p style="margin: 0; color: #64748b; font-size: 12px;">
        Responder directamente a este email contactará al usuario.
      </p>
    `;

    await client.send({
      to: 'soporte@aikestar.net',
      from: { email: fromEmail, name: 'Aikestar Soporte' },
      replyTo: { email: effectiveReplyTo, name: userName },
      subject: `[Soporte] ${subject}`,
      html: getEmailTemplate(content, 'Mensaje de Soporte'),
    });

    console.log(`[Email] Support email sent from ${userEmail} (reply-to: ${effectiveReplyTo}): ${subject}`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send support email:', error);
    return false;
  }
}

// Admin promotion notification email
export async function sendAdminPromotionEmail(
  userEmail: string,
  userName: string,
  promotedByName: string
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        ¡Ahora sos Administrador de Aikestar!
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola <strong style="color: #22d3ee;">${userName}</strong>,
      </p>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        <strong style="color: #ec4899;">${promotedByName}</strong> te ha otorgado el rol de administrador de la plataforma.
      </p>
      
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; margin: 24px 0;">
        <h3 style="margin: 0 0 16px; color: #22d3ee; font-size: 16px;">
          ¿Qué podés hacer como Admin?
        </h3>
        <ul style="margin: 0; padding-left: 20px; color: #cbd5e1; line-height: 2;">
          <li>Ver el listado completo de usuarios de la plataforma</li>
          <li>Monitorear métricas de uso y suscripciones</li>
          <li>Gestionar estados de administrador de otros usuarios</li>
          <li>Acceder a información de facturación y pagos</li>
          <li>Ver estadísticas generales del sistema</li>
        </ul>
      </div>
      
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Podés acceder al panel de administración desde el menú de tu cuenta.
      </p>
      
      <div style="text-align: center; margin: 32px 0;">
        <a href="${getAppBaseUrl()}/admin" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #ec4899 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Ir al Panel de Admin
        </a>
      </div>
      
      <p style="margin: 24px 0 0; line-height: 1.6; color: #94a3b8; font-size: 13px;">
        Este rol te otorga acceso a información sensible de la plataforma. Usalo con responsabilidad.
      </p>
    `;

    const [response] = await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: '¡Sos Administrador de Aikestar!',
      html: getEmailTemplate(content, 'Promoción a Administrador'),
    });

    console.log(`[Email] Admin promotion email sent to ${userEmail} (promoted by ${promotedByName}) - Status: ${response.statusCode}`);
    
    // Check if SendGrid accepted the email
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return true;
    } else {
      console.error(`[Email] SendGrid returned non-success status: ${response.statusCode}`);
      return false;
    }
  } catch (error: any) {
    console.error('[Email] Failed to send admin promotion email:', error.message || error);
    if (error.response?.body) {
      console.error('[Email] SendGrid error details:', JSON.stringify(error.response.body));
    }
    return false;
  }
}

export async function sendAdminNotificationEmail(
  userEmail: string, 
  userName: string, 
  notificationTitle: string,
  notificationMessage: string,
  imageUrl?: string | null,
  attachmentUrl?: string | null,
  attachmentName?: string | null
): Promise<boolean> {
  try {
    const { apiKey, email: fromEmail } = await getCredentials();
    const client = new MailService();
    client.setApiKey(apiKey);
    
    const appUrl = getAppBaseUrl();
    const toAbsolute = (u: string) => (u.startsWith('http') ? u : `${appUrl}${u.startsWith('/') ? '' : '/'}${u}`);
    const imageBlock = imageUrl
      ? `<div style="margin: 20px 0; text-align: center;">
           <img src="${toAbsolute(imageUrl)}" alt="Imagen adjunta" style="max-width: 100%; height: auto; border-radius: 8px; border: 1px solid #e4e4e7;" />
         </div>`
      : '';
    const attachmentBlock = attachmentUrl
      ? `<div style="margin: 20px 0;">
           <a href="${toAbsolute(attachmentUrl)}" style="display: inline-flex; align-items: center; gap: 8px; padding: 10px 14px; background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 8px; color: #18181b; text-decoration: none; font-size: 14px;">
             📎 ${attachmentName || 'Descargar archivo adjunto'}
           </a>
         </div>`
      : '';
    
    await client.send({
      to: userEmail,
      from: {
        email: fromEmail,
        name: 'Aikestar'
      },
      subject: `Aikestar: ${notificationTitle}`,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="width: 100%; max-width: 600px; border-collapse: collapse;">
          <!-- Header -->
          <tr>
            <td style="text-align: center; padding-bottom: 30px;">
              <div style="background: linear-gradient(135deg, #06b6d4, #ec4899); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-size: 28px; font-weight: bold; letter-spacing: -0.5px;">
                Aikestar
              </div>
            </td>
          </tr>
          
          <!-- Main Card -->
          <tr>
            <td style="background: white; border-radius: 12px; padding: 40px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);">
              <h1 style="margin: 0 0 20px; color: #18181b; font-size: 24px; font-weight: 600;">
                ${notificationTitle}
              </h1>
              
              <p style="margin: 0 0 20px; color: #71717a; font-size: 16px; line-height: 1.6;">
                Hola ${userName},
              </p>
              
              <div style="margin: 0 0 20px; color: #3f3f46; font-size: 16px; line-height: 1.7; white-space: pre-wrap;">
                ${notificationMessage}
              </div>
              ${imageBlock}
              ${attachmentBlock}
              <div style="text-align: center; padding-top: 20px; border-top: 1px solid #e4e4e7;">
                <a href="${appUrl}" style="display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #06b6d4, #0891b2); color: white; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 14px;">
                  Ir a Aikestar
                </a>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="text-align: center; padding-top: 30px;">
              <p style="margin: 0; color: #a1a1aa; font-size: 12px;">
                © ${new Date().getFullYear()} Aikestar. Todos los derechos reservados.
              </p>
              <p style="margin: 10px 0 0; color: #a1a1aa; font-size: 12px;">
                Este mensaje fue enviado por el equipo de Aikestar.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `,
    });
    
    console.log('[Email] Admin notification email sent to:', userEmail);
    return true;
  } catch (error: any) {
    console.error('[Email] Failed to send admin notification email:', error.message || error);
    if (error.response?.body) {
      console.error('[Email] SendGrid error details:', JSON.stringify(error.response.body));
    }
    return false;
  }
}

export async function sendCancelledDataReminderEmail(
  userEmail: string,
  userName: string,
  daysRemaining: number
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();

    const urgency = daysRemaining <= 7 ? 'alta' : 'media';
    const borderColor = urgency === 'alta' ? '#f87171' : '#fbbf24';
    const textColor = urgency === 'alta' ? '#f87171' : '#fbbf24';

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        ${daysRemaining <= 7 ? 'Última oportunidad para recuperar tu cuenta' : 'Tus datos en Aikestar serán eliminados pronto'}
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Hola ${userName},
      </p>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Tu suscripción de Aikestar fue cancelada y tu cuenta está inactiva. Tus datos siguen guardados, pero serán eliminados permanentemente si no volvés a suscribirte.
      </p>
      <div style="background: #1e293b; border: 1px solid ${borderColor}; border-radius: 8px; padding: 16px; margin: 24px 0;">
        <p style="margin: 0; color: ${textColor}; font-size: 14px;">
          <strong>Tus datos serán eliminados en ${daysRemaining} ${daysRemaining === 1 ? 'día' : 'días'}.</strong> Esto incluye todas tus organizaciones, transacciones, clientes y datos financieros.
        </p>
      </div>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Volvé a suscribirte para recuperar el acceso completo a tu cuenta y todos tus datos.
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${getAppBaseUrl()}/pricing" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Recuperar mi cuenta
        </a>
      </div>
      <p style="margin: 0; color: #94a3b8; font-size: 14px;">
        ¿Tenés preguntas? Escribinos a <a href="mailto:soporte@aikestar.net" style="color: #22d3ee;">soporte@aikestar.net</a>
      </p>
    `;

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: daysRemaining <= 7
        ? `Último aviso: tus datos serán eliminados en ${daysRemaining} días`
        : `Recordatorio: tus datos serán eliminados en ${daysRemaining} días`,
      html: getEmailTemplate(content, 'Recordatorio de Eliminación'),
    });

    console.log(`[Email] Cancelled data reminder sent to ${userEmail} (${daysRemaining} days remaining)`);
    return true;
  } catch (error) {
    console.error('[Email] Failed to send cancelled data reminder:', error);
    return false;
  }
}

export async function sendNewRegistrationAdminEmail(
  adminEmails: string[],
  newUser: {
    name: string;
    email: string;
    planType: string;
    accountType: 'personal' | 'business';
    organizationName: string;
    country: string;
    phoneNumber?: string;
  }
): Promise<boolean> {
  if (adminEmails.length === 0) {
    console.log('[Email] No admin emails to notify about new registration');
    return true;
  }

  try {
    const { client, fromEmail } = await getUncachableSendGridClient();

    const registrationDate = new Date().toLocaleString('es-AR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    const accountTypeLabel = newUser.accountType === 'business' ? 'Empresa' : 'Personal';

    const content = `
      <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px;">
        Nuevo usuario registrado
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Se registró un nuevo usuario en Aikestar. Acá tenés sus datos de contacto para ofrecerle onboarding:
      </p>
      <div style="background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; margin: 24px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; width: 140px; vertical-align: top;">Nombre</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px; font-weight: 600;">${newUser.name}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; vertical-align: top;">Email</td>
            <td style="padding: 8px 0; font-size: 14px;">
              <a href="mailto:${newUser.email}" style="color: #22d3ee; text-decoration: none; font-weight: 600;">${newUser.email}</a>
            </td>
          </tr>
          ${newUser.phoneNumber ? `<tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; vertical-align: top;">WhatsApp</td>
            <td style="padding: 8px 0; font-size: 14px;">
              <a href="https://wa.me/${newUser.phoneNumber.replace(/[^0-9]/g, '')}" style="color: #25D366; text-decoration: none; font-weight: 600;">${newUser.phoneNumber}</a>
              <span style="color: #94a3b8; font-weight: 400; margin-left: 6px;">(sin verificar)</span>
            </td>
          </tr>` : ''}
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; vertical-align: top;">Plan</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px;">
              <span style="display: inline-block; padding: 2px 10px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; border-radius: 12px; font-weight: 600; font-size: 12px; text-transform: uppercase;">${newUser.planType}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; vertical-align: top;">Tipo de cuenta</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px;">${accountTypeLabel}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; vertical-align: top;">Organización</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px;">${newUser.organizationName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; vertical-align: top;">País</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px;">${newUser.country}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; vertical-align: top;">Fecha de registro</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px;">${registrationDate}</td>
          </tr>
        </table>
      </div>
      <div style="text-align: center; margin: 32px 0;">
        ${newUser.phoneNumber ? `<a href="https://wa.me/${newUser.phoneNumber.replace(/[^0-9]/g, '')}?text=${encodeURIComponent('Hola ' + newUser.name + ', bienvenido/a a Aikestar! Soy del equipo de soporte. Estoy acá para ayudarte con tu onboarding.')}" style="display: inline-block; padding: 14px 32px; background: #25D366; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin-right: 12px;">
          Contactar por WhatsApp
        </a>` : ''}
        <a href="mailto:${newUser.email}?subject=Bienvenido%20a%20Aikestar%20-%20Onboarding" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Contactar por Email
        </a>
      </div>
      <p style="margin: 0; color: #94a3b8; font-size: 14px;">
        También podés ver todos los usuarios desde el <a href="${getAppBaseUrl()}/admin" style="color: #22d3ee; text-decoration: none;">Panel de Admin</a>.
      </p>
    `;

    const emailPromises = adminEmails.map(adminEmail =>
      client.send({
        to: adminEmail,
        from: { email: fromEmail, name: 'Aikestar' },
        subject: `Nuevo registro: ${newUser.name} (${newUser.planType})`,
        html: getEmailTemplate(content, 'Nuevo Registro'),
      })
    );

    const results = await Promise.allSettled(emailPromises);
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    if (failed > 0) {
      const failedDetails = results
        .map((r, i) => r.status === 'rejected' ? `${adminEmails[i]}: ${(r as PromiseRejectedResult).reason}` : null)
        .filter(Boolean);
      console.error(`[Email] Admin registration notification: ${succeeded} sent, ${failed} failed:`, failedDetails);
    } else {
      console.log(`[Email] New registration admin notification sent to ${succeeded} admin(s) for user ${newUser.email}`);
    }
    return failed === 0;
  } catch (error) {
    console.error('[Email] Failed to send new registration admin email:', error);
    return false;
  }
}

export async function sendCancellationAdminEmail(
  adminEmails: string[],
  cancelledUser: {
    name: string;
    email: string;
    planType: string;
    phoneNumber?: string;
    accessEndsAt: string | null;
  }
): Promise<boolean> {
  if (adminEmails.length === 0) {
    console.log('[Email] No admin emails to notify about cancellation');
    return true;
  }

  try {
    const { client, fromEmail } = await getUncachableSendGridClient();

    const cancellationDate = new Date().toLocaleString('es-AR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Argentina/Buenos_Aires'
    });

    const accessEndFormatted = cancelledUser.accessEndsAt
      ? new Date(cancelledUser.accessEndsAt).toLocaleDateString('es-AR', {
          dateStyle: 'long',
          timeZone: 'America/Argentina/Buenos_Aires'
        })
      : 'No disponible';

    const content = `
      <h2 style="margin: 0 0 20px; color: #f87171; font-size: 22px;">
        Cancelación de suscripción
      </h2>
      <p style="margin: 0 0 16px; line-height: 1.6; color: #cbd5e1;">
        Un usuario canceló su suscripción en Aikestar. Acá tenés los detalles:
      </p>
      <div style="background: #1e293b; border: 1px solid #f87171; border-radius: 12px; padding: 24px; margin: 24px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; width: 160px; vertical-align: top;">Nombre</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px; font-weight: 600;">${cancelledUser.name}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; vertical-align: top;">Email</td>
            <td style="padding: 8px 0; font-size: 14px;">
              <a href="mailto:${cancelledUser.email}" style="color: #22d3ee; text-decoration: none; font-weight: 600;">${cancelledUser.email}</a>
            </td>
          </tr>
          ${cancelledUser.phoneNumber ? `<tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; vertical-align: top;">WhatsApp</td>
            <td style="padding: 8px 0; font-size: 14px;">
              <a href="https://wa.me/${cancelledUser.phoneNumber.replace(/[^0-9]/g, '')}" style="color: #25D366; text-decoration: none; font-weight: 600;">${cancelledUser.phoneNumber}</a>
            </td>
          </tr>` : ''}
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; vertical-align: top;">Plan cancelado</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px;">
              <span style="display: inline-block; padding: 2px 10px; background: #7f1d1d; color: #fca5a5; border-radius: 12px; font-weight: 600; font-size: 12px; text-transform: uppercase;">${cancelledUser.planType}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; vertical-align: top;">Fecha de cancelación</td>
            <td style="padding: 8px 0; color: #f1f5f9; font-size: 14px;">${cancellationDate}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; font-size: 14px; vertical-align: top;">Acceso hasta</td>
            <td style="padding: 8px 0; color: #fbbf24; font-size: 14px; font-weight: 600;">${accessEndFormatted}</td>
          </tr>
        </table>
      </div>
      <div style="text-align: center; margin: 32px 0;">
        ${cancelledUser.phoneNumber ? `<a href="https://wa.me/${cancelledUser.phoneNumber.replace(/[^0-9]/g, '')}?text=${encodeURIComponent('Hola ' + cancelledUser.name + ', vimos que cancelaste tu suscripción de Aikestar. ¿Hay algo que podamos hacer para ayudarte?')}" style="display: inline-block; padding: 14px 32px; background: #25D366; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; margin-right: 12px;">
          Contactar por WhatsApp
        </a>` : ''}
        <a href="mailto:${cancelledUser.email}?subject=Sobre%20tu%20suscripci%C3%B3n%20en%20Aikestar" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
          Contactar por Email
        </a>
      </div>
      <p style="margin: 0; color: #94a3b8; font-size: 14px;">
        Podés ver todos los usuarios desde el <a href="${getAppBaseUrl()}/admin" style="color: #22d3ee; text-decoration: none;">Panel de Admin</a>.
      </p>
    `;

    const emailPromises = adminEmails.map(adminEmail =>
      client.send({
        to: adminEmail,
        from: { email: fromEmail, name: 'Aikestar' },
        subject: `Cancelación: ${cancelledUser.name} (${cancelledUser.planType})`,
        html: getEmailTemplate(content, 'Cancelación de Suscripción'),
      })
    );

    const results = await Promise.allSettled(emailPromises);
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    if (failed > 0) {
      const failedDetails = results
        .map((r, i) => r.status === 'rejected' ? `${adminEmails[i]}: ${(r as PromiseRejectedResult).reason}` : null)
        .filter(Boolean);
      console.error(`[Email] Admin cancellation notification: ${succeeded} sent, ${failed} failed:`, failedDetails);
    } else {
      console.log(`[Email] Cancellation admin notification sent to ${succeeded} admin(s) for user ${cancelledUser.email}`);
    }
    return failed === 0;
  } catch (error) {
    console.error('[Email] Failed to send cancellation admin email:', error);
    return false;
  }
}

// Invoice PDF email — sends an emitted invoice (PDF attachment) to the receiver
// (and optional CCs / sender copy). Used by the wizard's "emit invoice" step.
export interface InvoicePdfEmailParams {
  to: string;
  cc?: string[];
  bcc?: string[];
  organizationName: string;
  emitterName?: string | null;
  docType: string;
  voucherNumber: string;
  total: string | number;
  currency?: string;
  pdfBuffer: Buffer;
  pdfFilename: string;
  isSimulated?: boolean;
  customMessage?: string | null;
}

export async function sendInvoicePdfEmail(params: InvoicePdfEmailParams): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    const totalNum = typeof params.total === 'number' ? params.total : Number(params.total) || 0;
    const totalLabel = `${(params.currency || 'ARS')} ${totalNum.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;

    const simulatedBanner = params.isSimulated
      ? `<div style="background:#fee2e2;border:1px solid #fecaca;color:#b91c1c;padding:12px 16px;border-radius:8px;margin:0 0 20px;font-size:13px;">
          <strong>Comprobante de prueba.</strong> Este documento fue generado en modo simulado y no tiene validez fiscal.
        </div>`
      : '';

    const messageBlock = params.customMessage
      ? `<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin:24px 0;color:#cbd5e1;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(params.customMessage)}</div>`
      : '';

    const content = `
      <h2 style="margin:0 0 20px;color:#f1f5f9;font-size:22px;">
        Te enviamos tu factura
      </h2>
      ${simulatedBanner}
      <p style="margin:0 0 16px;line-height:1.6;color:#cbd5e1;">
        Hola, te compartimos el comprobante <strong style="color:#22d3ee;">${escapeHtml(params.docType)} ${escapeHtml(params.voucherNumber)}</strong> emitido por <strong>${escapeHtml(params.emitterName || params.organizationName)}</strong>.
      </p>
      <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin:24px 0;color:#e2e8f0;">
        <p style="margin:0 0 6px;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;">Total</p>
        <p style="margin:0;font-size:22px;font-weight:600;">${escapeHtml(totalLabel)}</p>
      </div>
      ${messageBlock}
      <p style="margin:0;color:#94a3b8;font-size:13px;">El comprobante completo va adjunto a este correo en formato PDF.</p>
    `;

    const msg: any = {
      to: params.to,
      from: { email: fromEmail, name: params.organizationName || 'Aikestar' },
      subject: `Factura ${params.docType} ${params.voucherNumber} — ${params.organizationName}`,
      html: getEmailTemplate(content, 'Factura electrónica'),
      attachments: [{
        content: params.pdfBuffer.toString('base64'),
        filename: params.pdfFilename,
        type: 'application/pdf',
        disposition: 'attachment',
      }],
    };
    if (params.cc && params.cc.length > 0) msg.cc = params.cc;
    if (params.bcc && params.bcc.length > 0) msg.bcc = params.bcc;

    await client.send(msg);
    console.log(`[Email] Invoice ${params.docType} ${params.voucherNumber} sent to ${params.to}`);
    return true;
  } catch (error: any) {
    console.error('[Email] Failed to send invoice PDF email:', error?.message || error);
    if (error?.response?.body) {
      console.error('[Email] SendGrid response:', JSON.stringify(error.response.body));
    }
    return false;
  }
}

export interface CreditNoteBadResponseAlertParams {
  to: string;
  recipientName: string;
  organizationName: string;
  invoiceDocType: string;
  invoiceVoucher: string;
  reason: string;
  errorMessage: string;
  transactionId: string;
  environment: string;
}

/**
 * Notifies an org admin/owner that a credit-note emission returned a
 * BAD_RESPONSE from the provider — the NC may or may not have actually
 * been registered with ARCA and needs manual review. Best-effort: returns
 * false on any send failure, never throws.
 */
export async function sendCreditNoteBadResponseAlertEmail(
  params: CreditNoteBadResponseAlertParams,
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    const baseUrl = getAppBaseUrl();
    const detailUrl = `${baseUrl}/transactions?txId=${encodeURIComponent(params.transactionId)}`;

    const docLabel = `${params.invoiceDocType} ${params.invoiceVoucher}`.trim();

    const content = `
      <h2 style="margin:0 0 16px;color:#f1f5f9;font-size:22px;">
        Nota de crédito en estado ambiguo
      </h2>
      <p style="margin:0 0 16px;line-height:1.6;color:#cbd5e1;">
        Hola ${escapeHtml(params.recipientName)}, intentamos anular una factura emitida por <strong>${escapeHtml(params.organizationName)}</strong> y el proveedor devolvió una respuesta incompleta.
      </p>
      <p style="margin:0 0 16px;line-height:1.6;color:#cbd5e1;">
        Es posible que la nota de crédito haya quedado registrada en ARCA aunque no recibimos confirmación. Te recomendamos revisar el movimiento antes de reintentar la emisión para evitar duplicar la anulación.
      </p>
      <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin:24px 0;color:#e2e8f0;font-size:14px;line-height:1.7;">
        <p style="margin:0 0 6px;"><strong style="color:#94a3b8;">Factura:</strong> ${escapeHtml(docLabel || '—')}</p>
        <p style="margin:0 0 6px;"><strong style="color:#94a3b8;">Motivo de la NC:</strong> ${escapeHtml(params.reason || '—')}</p>
        <p style="margin:0 0 6px;"><strong style="color:#94a3b8;">Error del proveedor:</strong> ${escapeHtml(params.errorMessage || '—')}</p>
        <p style="margin:0;"><strong style="color:#94a3b8;">Entorno:</strong> ${escapeHtml(params.environment)}</p>
      </div>
      <div style="text-align:center;margin:24px 0;">
        <a href="${detailUrl}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#22d3ee 0%,#0891b2 100%);color:#0f172a;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
          Ver el movimiento
        </a>
      </div>
      <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">
        Si necesitás confirmar si la nota de crédito quedó registrada en ARCA, escribinos a soporte@aikestar.net y la verificamos por vos. Si preferís reintentar directamente, podés hacerlo desde el detalle del movimiento.
      </p>
    `;

    await client.send({
      to: params.to,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: `Aikestar: revisión manual de nota de crédito (${docLabel || params.transactionId})`,
      html: getEmailTemplate(content, 'Nota de crédito en revisión'),
    });

    console.log(`[Email] Credit-note BAD_RESPONSE alert sent to ${params.to} (tx ${params.transactionId})`);
    return true;
  } catch (error: any) {
    console.warn('[Email] Failed to send credit-note BAD_RESPONSE alert:', error?.message || error);
    if (error?.response?.body) {
      console.warn('[Email] SendGrid response:', JSON.stringify(error.response.body));
    }
    return false;
  }
}

export interface InvoiceBadResponseAlertParams {
  to: string;
  recipientName: string;
  organizationName: string;
  receiverName: string;
  totalLabel: string;
  errorMessage: string;
  transactionId: string;
  environment: string;
}

/**
 * Notifies an org admin/owner that a factura emission returned a
 * BAD_RESPONSE from the provider — the comprobante may or may not have
 * actually been registered with ARCA and needs manual review before
 * reintentar. Mirror of sendCreditNoteBadResponseAlertEmail. Best-effort.
 */
export async function sendInvoiceBadResponseAlertEmail(
  params: InvoiceBadResponseAlertParams,
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    const baseUrl = getAppBaseUrl();
    const detailUrl = `${baseUrl}/transactions?txId=${encodeURIComponent(params.transactionId)}`;

    const content = `
      <h2 style="margin:0 0 16px;color:#f1f5f9;font-size:22px;">
        Factura en estado ambiguo
      </h2>
      <p style="margin:0 0 16px;line-height:1.6;color:#cbd5e1;">
        Hola ${escapeHtml(params.recipientName)}, intentamos emitir una factura electrónica desde <strong>${escapeHtml(params.organizationName)}</strong> y el proveedor devolvió una respuesta incompleta.
      </p>
      <p style="margin:0 0 16px;line-height:1.6;color:#cbd5e1;">
        Es posible que la factura haya quedado registrada en ARCA aunque no recibimos confirmación del CAE. Te recomendamos revisar el movimiento en Aikestar y, si es necesario, consultar en el portal de ARCA antes de reintentar la emisión para evitar duplicar el comprobante.
      </p>
      <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin:24px 0;color:#e2e8f0;font-size:14px;line-height:1.7;">
        <p style="margin:0 0 6px;"><strong style="color:#94a3b8;">Cliente:</strong> ${escapeHtml(params.receiverName || '—')}</p>
        <p style="margin:0 0 6px;"><strong style="color:#94a3b8;">Total:</strong> ${escapeHtml(params.totalLabel || '—')}</p>
        <p style="margin:0 0 6px;"><strong style="color:#94a3b8;">Error del proveedor:</strong> ${escapeHtml(params.errorMessage || '—')}</p>
        <p style="margin:0;"><strong style="color:#94a3b8;">Entorno:</strong> ${escapeHtml(params.environment)}</p>
      </div>
      <div style="text-align:center;margin:24px 0;">
        <a href="${detailUrl}" style="display:inline-block;padding:14px 28px;background:linear-gradient(135deg,#22d3ee 0%,#0891b2 100%);color:#0f172a;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
          Ver el movimiento
        </a>
      </div>
      <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">
        Si necesitás confirmar si la factura quedó registrada en ARCA, escribinos a soporte@aikestar.net y la verificamos por vos. Si preferís reintentar directamente, podés hacerlo desde el detalle del movimiento.
      </p>
    `;

    await client.send({
      to: params.to,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: `Aikestar: revisión manual de factura (${params.transactionId})`,
      html: getEmailTemplate(content, 'Factura en revisión'),
    });

    console.log(`[Email] Invoice BAD_RESPONSE alert sent to ${params.to} (tx ${params.transactionId})`);
    return true;
  } catch (error: any) {
    console.warn('[Email] Failed to send invoice BAD_RESPONSE alert:', error?.message || error);
    if (error?.response?.body) {
      console.warn('[Email] SendGrid response:', JSON.stringify(error.response.body));
    }
    return false;
  }
}

export interface SystemErrorAlertParams {
  recipient: string;
  source: string;
  message: string;
  stack?: string | null;
  statusCode?: number | null;
  method?: string | null;
  path?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  organizationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  occurredAt: Date;
}

// Alerta interna para el equipo: se dispara ante errores graves del sistema
// (respuestas 500+ del servidor o caídas inesperadas del proceso). Incluye todo
// el detalle necesario para diagnosticar: qué pasó, cuándo (hora Argentina), qué
// usuario/organización, qué operación y contexto técnico. No envía datos
// sensibles (contraseñas/tokens) porque sólo recibe metadatos del request.
export async function sendSystemErrorAlertEmail(params: SystemErrorAlertParams): Promise<boolean> {
  try {
    const { apiKey, email: fromEmail } = await getCredentials();
    const client = new MailService();
    client.setApiKey(apiKey);

    const when = params.occurredAt.toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      dateStyle: 'full',
      timeStyle: 'medium',
    });

    const stackText = (params.stack || '').slice(0, 6000);
    const operation = `${params.method || '—'} ${params.path || ''}`.trim();
    const userLabel = params.userEmail
      ? `${params.userEmail}${params.userId ? ` (id: ${params.userId})` : ''}`
      : (params.userId ? `id: ${params.userId}` : 'Anónimo / no logueado');

    const rows: Array<[string, string]> = [
      ['Tipo de error', params.source],
      ['Mensaje', params.message || '—'],
      ...(params.statusCode ? [['Código', String(params.statusCode)] as [string, string]] : []),
      ['Operación', operation || '—'],
      ['Usuario', userLabel],
      ['Organización', params.organizationId || '—'],
      ['Fecha y hora (Argentina)', when],
      ['IP', params.ip || '—'],
      ['Dispositivo / navegador', params.userAgent || '—'],
    ];

    const rowsHtml = rows.map(([k, v]) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #334155;color:#94a3b8;font-size:13px;font-weight:600;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #334155;color:#e2e8f0;font-size:13px;word-break:break-word;">${escapeHtml(v)}</td>
      </tr>`).join('');

    const stackBlock = stackText
      ? `<div style="margin:20px 0 0;">
           <p style="margin:0 0 6px;color:#94a3b8;font-size:13px;font-weight:600;">Detalle técnico</p>
           <pre style="margin:0;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:14px;color:#cbd5e1;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;overflow-x:auto;">${escapeHtml(stackText)}</pre>
         </div>`
      : '';

    await client.send({
      to: params.recipient,
      from: { email: fromEmail, name: 'Aikestar Alertas' },
      subject: `[Aikestar] Error del sistema: ${(params.message || 'sin mensaje').slice(0, 120)}`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" style="width:100%;max-width:640px;border-collapse:collapse;">
          <tr>
            <td style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:28px;">
              <div style="display:inline-block;background:#7f1d1d;color:#fecaca;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;letter-spacing:0.3px;">ERROR DEL SISTEMA</div>
              <h1 style="margin:16px 0 8px;color:#f8fafc;font-size:20px;font-weight:600;">Ocurrió un error grave en producción</h1>
              <p style="margin:0 0 20px;color:#94a3b8;font-size:14px;line-height:1.6;">Se detectó un error que impidió completar una operación. A continuación, el detalle para diagnosticarlo.</p>
              <table role="presentation" style="width:100%;border-collapse:collapse;background:#0f172a;border:1px solid #334155;border-radius:8px;overflow:hidden;">
                ${rowsHtml}
              </table>
              ${stackBlock}
            </td>
          </tr>
          <tr>
            <td style="text-align:center;padding-top:20px;">
              <p style="margin:0;color:#64748b;font-size:11px;">Alerta automática de Aikestar. Para dejar de recibirla, ajustá la configuración de alertas de error.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    });

    console.log('[Email] System error alert sent to:', params.recipient);
    return true;
  } catch (error: any) {
    console.error('[Email] Failed to send system error alert:', error.message || error);
    return false;
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
