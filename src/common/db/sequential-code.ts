import { Prisma, PrismaClient } from '@prisma/client';

export type Db =
  | PrismaClient
  | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export async function nextSequentialCode(
  db: Db,
  opts: {
    table: Prisma.Sql;
    column: Prisma.Sql;
    prefix: string;
    /** Số chữ số của phần số, mặc định 6 (STN000001) */
    width?: number;
  },
): Promise<string> {
  const { table, column, prefix, width = 6 } = opts;

  // $executeRaw chứ không phải $queryRaw: `pg_advisory_xact_lock` trả kiểu `void`,
  // Prisma không deserialize được cột đó và ném P2010 ngay ở lần cấp mã đầu tiên.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`code:${prefix}`}))`;

  // `{width,}` chứ không phải `{width}`, và sắp theo ĐỘ DÀI trước: khi số thứ tự vượt
  // 10^width thì mã dài thêm một chữ số (STN999999 → STN1000000). Khớp đúng `width` chữ
  // số sẽ bỏ qua hẳn các mã đã tràn, còn so sánh chuỗi trần thì 'STN999999' > 'STN1000000'
  // ('9' > '1') — cả hai đều khiến số thứ tự tụt về 1000000 và cấp lại mã đã tồn tại.
  // Mọi mã đều được pad đủ `width` nên dài hơn = lớn hơn.
  const rows = await db.$queryRaw<Array<{ code: string }>>`
    SELECT ${column} AS code
    FROM ${table}
    WHERE ${column} ~ ${`^${prefix}[0-9]{${width},}$`}
    ORDER BY length(${column}) DESC, ${column} DESC
    LIMIT 1
  `;

  const nextSeq = rows.length
    ? Number(rows[0].code.slice(prefix.length)) + 1
    : 1;
  return `${prefix}${String(nextSeq).padStart(width, '0')}`;
}
