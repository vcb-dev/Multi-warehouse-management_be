/** Ghép first_name/last_name (Sapo) thành tên hiển thị, thứ tự Việt: Họ trước, Tên sau. */
export function userDisplayName(
  u: { firstName: string | null; lastName: string | null } | null | undefined,
): string | null {
  if (!u) return null;
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || null;
}
