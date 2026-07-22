/**
 * Supabase đôi khi để default_transaction_read_only=on (vd sau khi đầy disk).
 * Gắn options để mỗi connection mới ghi được.
 */
export function ensureWritableDbUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const normalized = url.replace(/^postgresql:/i, 'http:');
    const u = new URL(normalized);
    const existing = u.searchParams.get('options') ?? '';
    if (!/default_transaction_read_only/i.test(existing)) {
      const add = '-c default_transaction_read_only=off';
      u.searchParams.set('options', existing ? `${existing} ${add}` : add);
    }
    return u.toString().replace(/^http:/i, 'postgresql:');
  } catch {
    return url;
  }
}
