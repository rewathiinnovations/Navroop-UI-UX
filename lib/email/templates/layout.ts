export function workspaceName() {
  return process.env.NEXT_PUBLIC_WORKSPACE_NAME || 'Navroop';
}

export function wrapEmailHtml(title: string, innerHtml: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="480" cellspacing="0" cellpadding="0" style="max-width:480px;width:100%;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;">
          <tr>
            <td style="padding:24px 24px 8px 24px;font-size:18px;font-weight:bold;color:#18181b;">
              ${escapeHtml(workspaceName())}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 24px 24px 24px;font-size:15px;line-height:1.55;color:#3f3f46;">
              ${innerHtml}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
