import { allowEmail, type EmailClass } from './rate-limit';

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  emailClass?: EmailClass;
};

export type SendEmailResult = { id: string } | { ok: false; error: string };

function workspaceFrom() {
  const workspace = process.env.NEXT_PUBLIC_WORKSPACE_NAME || 'Navroop';
  return process.env.EMAIL_FROM || `${workspace} <noreply@localhost>`;
}

function fail(error: unknown, context: string): SendEmailResult {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[email] ${context}:`, message);
  return { ok: false, error: message };
}

async function sendViaResend(input: SendEmailInput, apiKey: string): Promise<SendEmailResult> {
  try {
    // Trusted host — do not route through safeFetch.
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: workspaceFrom(),
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!response.ok || !data.id) {
      return fail(data.message || `Resend HTTP ${response.status}`, 'resend failed');
    }
    return { id: data.id };
  } catch (error) {
    return fail(error, 'resend threw');
  }
}

function sendViaDevLog(input: SendEmailInput): SendEmailResult {
  try {
    const id = `dev_${Date.now().toString(36)}`;
    console.log('[email:dev] --- begin ---');
    console.log(`[email:dev] id=${id}`);
    console.log(`[email:dev] to=${input.to}`);
    console.log(`[email:dev] subject=${input.subject}`);
    console.log('[email:dev] text:');
    console.log(input.text);
    console.log('[email:dev] html:');
    console.log(input.html);
    console.log('[email:dev] --- end ---');
    return { id };
  } catch (error) {
    return fail(error, 'dev driver failed');
  }
}

/** Provider-agnostic send. Never throws. Dev driver logs the full email (including links). */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  try {
    const to = String(input.to || '').trim();
    const subject = String(input.subject || '').trim();
    if (!to || !subject) {
      return { ok: false, error: 'to and subject are required' };
    }

    const gate = allowEmail({ to, emailClass: input.emailClass });
    if (!gate.allowed) {
      return { ok: false, error: 'Email rate limit reached' };
    }

    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      return sendViaDevLog({ ...input, to, subject });
    }
    return await sendViaResend({ ...input, to, subject }, apiKey);
  } catch (error) {
    return fail(error, 'sendEmail');
  }
}
