import { Supplier } from '@prisma/client';

type SupplierWithRelations = Supplier & {
  assignedTo?: { name: string | null; email: string } | null;
};

export function serializeSupplier(s: SupplierWithRelations) {
  return {
    id: s.id.toString(),
    code: s.code,
    name: s.name,
    email: s.email,
    phone: s.phone,
    website: s.website,
    fax: s.fax,
    tax_code: s.taxCode,
    address: {
      country: s.country,
      province: s.province,
      district: s.district,
      ward: s.ward,
      address: s.address,
    },
    assigned_to: s.assignedToId?.toString() ?? null,
    assigned_to_name: s.assignedTo?.name ?? s.assignedTo?.email ?? null,
    tags: s.tags,
    is_active: s.isActive,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}
