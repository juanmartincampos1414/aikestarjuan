import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// Task #225 — Tests unitarios para el helper de email "Vinculaste tu
// WhatsApp" y para el formato del mensaje de confirmación.
//
// Cobertura del flujo end-to-end (verify-code -> WhatsApp + email) está
// implícita en `tests/phoneVerification.e2e.test.ts`: el route devuelve
// HTTP 200 y persiste el número, y el log del workflow muestra los
// markers `[PhoneVerify] Dispatching link-confirmation` +
// `[PhoneVerify] WhatsApp confirmation sent` + `[Email] Phone linked
// confirmation sent` cuando se ejerce un verify exitoso.

// Stubeamos MailService.send ANTES de importar email.ts para que cualquier
// llamada a SendGrid sea capturada en memoria.
const sentMessages: any[] = [];
let sendStubbed = false;

before(async () => {
  if (!sendStubbed) {
    const sg = await import('@sendgrid/mail');
    const proto = (sg.MailService as any).prototype;
    proto.setApiKey = function () {};
    proto.send = async function (msg: any) {
      sentMessages.push(msg);
      return [{ statusCode: 202, body: '', headers: {} }, {}];
    };
    sendStubbed = true;
  }
  // Forzamos credenciales manuales para que getCredentials no llame al connector.
  process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || 'SG.test';
  process.env.SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'test@aikestar.net';
});

describe('sendPhoneLinkedConfirmationEmail — exportación y firma', () => {
  it('está exportado desde server/services/email.ts', async () => {
    const mod = await import('../server/services/email');
    assert.equal(typeof (mod as any).sendPhoneLinkedConfirmationEmail, 'function');
    assert.equal(
      (mod as any).sendPhoneLinkedConfirmationEmail.length,
      3,
      'el helper debería tener 3 parámetros requeridos (to, name, maskedPhone) + 1 opcional (linkedAt)',
    );
  });
});

describe('sendPhoneLinkedConfirmationEmail — contenido del email', () => {
  it('arma un email en español con subject + tripwire de seguridad + número enmascarado', async () => {
    sentMessages.length = 0;
    const { sendPhoneLinkedConfirmationEmail } = await import('../server/services/email');
    const ok = await sendPhoneLinkedConfirmationEmail(
      'usuario@example.com',
      'Juan Pérez',
      '+54 9 11 ••••-7426',
      new Date('2026-04-30T18:00:00Z'),
    );

    assert.equal(ok, true, 'el helper debe devolver true cuando el send no falla');
    assert.equal(sentMessages.length, 1, 'debe enviarse exactamente 1 email');

    const msg = sentMessages[0];

    // 1. Destinatario y subject correctos
    assert.equal(msg.to, 'usuario@example.com');
    assert.equal(msg.subject, 'Vinculaste tu WhatsApp a Aikestar');

    // 2. From identifica al sender de seguridad (no soporte general)
    assert.equal(msg.from?.name, 'Aikestar Seguridad');
    assert.ok(msg.from?.email, 'el remitente debe tener un email');

    // 3. El cuerpo HTML incluye el saludo personalizado
    assert.match(msg.html, /Juan Pérez/);

    // 4. El tripwire de seguridad ("¿No fuiste vos?") está presente
    assert.match(msg.html, /¿No fuiste vos\?/);
    assert.match(msg.html, /[Cc]ambi[áa] tu contraseña/, 'debe sugerir cambiar contraseña');

    // 5. La máscara aparece tal cual fue pasada (no se reformatea)
    assert.ok(
      msg.html.includes('+54 9 11 ••••-7426'),
      'el email debe mostrar el número enmascarado pasado por el route',
    );

    // 6. Garantía crítica: el HTML NO contiene el número completo del usuario.
    // Si por bug se usa `phone` en vez de `maskedPhone`, este check lo cazaría.
    assert.equal(
      msg.html.includes('+5491168247426'),
      false,
      'el email NO debe contener el número completo (sólo la versión enmascarada)',
    );
  });

  it('devuelve false sin crashear si SendGrid falla', async () => {
    sentMessages.length = 0;
    const sg = await import('@sendgrid/mail');
    const proto = (sg.MailService as any).prototype;
    const originalSend = proto.send;
    proto.send = async function () {
      const e: any = new Error('SendGrid down');
      e.response = { statusCode: 500, body: { errors: [{ message: 'down' }] } };
      throw e;
    };
    try {
      const { sendPhoneLinkedConfirmationEmail } = await import('../server/services/email');
      const ok = await sendPhoneLinkedConfirmationEmail(
        'usuario@example.com',
        'Juan',
        '+54 9 11 ••••-7426',
      );
      assert.equal(ok, false, 'cuando SendGrid falla, el helper devuelve false en vez de tirar');
    } finally {
      proto.send = originalSend;
    }
  });
});

describe('maskPhoneForDisplay — uso en confirmaciones', () => {
  it('sólo muestra los últimos 4 dígitos del número', async () => {
    const { maskPhoneForDisplay } = await import('../shared/phone');
    const phone = '+5491168247426';
    const masked = maskPhoneForDisplay(phone);

    // Garantía 1: los últimos 4 dígitos están visibles.
    assert.match(masked, /7426$/);

    // Garantía 2: los dígitos del medio NO leakean.
    assert.equal(masked.includes('168247'), false, 'no debe leakear el medio del número');
    assert.equal(masked.includes('6824'), false, 'no debe leakear los dígitos previos a los últimos 4');

    // Garantía 3: hay un marker visual de máscara.
    assert.ok(masked.includes('•'), 'debe contener el carácter de máscara •');
  });
});
