import { VariantPriceHistory, User } from '@prisma/client';
import { userDisplayName } from '../../common/utils/user-display-name';

const FIELD_LABELS = { price: 'Giá bán', cost: 'Giá vốn' } as const;
const SOURCE_LABELS = {
  manual: 'Sửa tay',
  import: 'Import Excel',
  create: 'Tạo mới',
} as const;

type Row = VariantPriceHistory & {
  changedBy: Pick<User, 'firstName' | 'lastName' | 'email'> | null;
};

export function serializeVariantPriceHistory(row: Row) {
  return {
    id: row.id.toString(),
    field: row.field as 'price' | 'cost',
    field_label: FIELD_LABELS[row.field as 'price' | 'cost'] ?? row.field,
    old_value: row.oldValue != null ? Number(row.oldValue) : null,
    new_value: Number(row.newValue),
    source: row.source,
    source_label:
      SOURCE_LABELS[row.source as keyof typeof SOURCE_LABELS] ?? row.source,
    changed_by_name:
      userDisplayName(row.changedBy) ?? row.changedBy?.email ?? 'Hệ thống',
    created_at: row.createdAt.toISOString(),
  };
}
