import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Task #212 (security follow-up): the WhatsApp webhook must NOT leak whether
// a phone number is bound to an existing Aike account. Concretely, the reply
// text sent to Twilio for "no user with this phone" and for "user exists but
// phone_verified=false" must be byte-identical, so an attacker who controls
// any WhatsApp number cannot enumerate registered phones by comparing replies.
//
// This is a structural test: we read the route source and assert that BOTH
// branches send the SAME message constant. We do NOT try to spin up the
// webhook from the test process and intercept Twilio fetches because:
//   • the webhook process runs in a different node (the workflow), so a
//     globalThis.fetch patch in the test process has no effect there;
//   • the message constant is defined inline in the route handler, making
//     a source-level diff the most reliable proof of identity.
//
// The test will start failing the moment someone re-introduces two distinct
// reply strings (for example by accepting a "personalized" onboarding text
// in the unbound branch).

const FILE = path.join(process.cwd(), 'server/routes/whatsapp.ts');

describe('Task #212 — webhook anti-enumeration (structural)', () => {
  it('the !user branch and the !user.phoneVerified branch send the SAME message constant', () => {
    const src = fs.readFileSync(FILE, 'utf8');

    // Capture the entire `app.post('/api/whatsapp/webhook', ...)` handler body
    // up to the first ` const organizations = ` (stable boundary that comes
    // right after the verify-or-bail block in the current implementation).
    const handlerStart = src.indexOf("app.post('/api/whatsapp/webhook'");
    assert.ok(handlerStart > -1, 'webhook handler not found in whatsapp.ts');
    const handlerEnd = src.indexOf('const organizations = await storage.getOrganizationsByUser', handlerStart);
    assert.ok(handlerEnd > -1, 'verification block boundary not found');
    const block = src.slice(handlerStart, handlerEnd);

    // Find both `if` branches.
    const unboundIdx = block.search(/if\s*\(\s*!user\s*\)\s*\{/);
    const unverifiedIdx = block.search(/if\s*\(\s*user\.phoneVerified\s*!==\s*true\s*\)\s*\{/);
    assert.ok(unboundIdx > -1, 'expected `if (!user) {` branch in webhook');
    assert.ok(unverifiedIdx > -1, 'expected `if (user.phoneVerified !== true) {` branch in webhook');

    // Both branches MUST call sendWhatsAppMessage with the SAME identifier
    // (currently the `NEEDS_VERIFICATION_REPLY` constant). Capture the second
    // argument to sendWhatsAppMessage in each branch and assert byte equality.
    const grabSecondArg = (idx: number): string => {
      const slice = block.slice(idx, idx + 600);
      const m = slice.match(/sendWhatsAppMessage\s*\(\s*From\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
      assert.ok(m, `could not find sendWhatsAppMessage(From, IDENT) call in branch starting at offset ${idx}\nslice was:\n${slice}`);
      return m[1];
    };

    const unboundIdent = grabSecondArg(unboundIdx);
    const unverifiedIdent = grabSecondArg(unverifiedIdx);

    assert.equal(
      unboundIdent,
      unverifiedIdent,
      `Anti-enumeration leak: unbound branch sends "${unboundIdent}" but unverified-bound branch sends "${unverifiedIdent}". They must be the SAME identifier so the message bytes are identical.`,
    );

    // Sanity-check that the shared constant is actually a non-empty string
    // literal (so a future refactor doesn't accidentally point both branches
    // at an empty string and silently break the bot).
    const constMatch = src.match(new RegExp(`const\\s+${unboundIdent}\\s*=\\s*([\`'\"])([\\s\\S]+?)\\1\\s*;`));
    if (constMatch) {
      assert.ok(constMatch[2].length > 30, `${unboundIdent} should be a meaningful message, got ${constMatch[2].length} chars`);
    } else {
      // It might be defined as a multi-line string concatenation. Fall back to
      // searching for the assignment line without the closing `;`.
      const looseMatch = src.match(new RegExp(`const\\s+${unboundIdent}\\s*=`));
      assert.ok(looseMatch, `expected a \`const ${unboundIdent} = ...\` declaration in whatsapp.ts`);
    }
  });
});
