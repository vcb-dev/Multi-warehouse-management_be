import { Injectable, NotFoundException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { assertLocationAccess, isAdminUser } from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { getReport, reportCatalog } from './report-registry';
import {
  DashboardOverviewQueryDto,
  PinReportDto,
  ProductMonthlyOpsQueryDto,
  RunReportQueryDto,
} from './report.dto';
import {
  resolveDashboardPeriod,
  runDashboardOverview,
} from './reports/dashboard-overview.report';
import { runProductMonthlyOps } from './reports/product-monthly-ops.report';
import {
  ReportColumn,
  ReportContext,
  ReportDef,
  ReportRow,
} from './report.types';

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_RANGE_DAYS = 30;
const DEFAULT_TOP_LIMIT = 10;
/** Số dòng "Sản phẩm bán chạy" và "Nhật ký hoạt động" trên màn Tổng quan — theo Sapo. */
const DASHBOARD_TOP_PRODUCTS = 5;
const DASHBOARD_ACTIVITY_LIMIT = 8;
/** Chặn export vô hạn — 100k dòng đã quá đủ cho báo cáo vận hành. */
const EXPORT_LIMIT = 100_000;

@Injectable()
export class ReportService {
  constructor(private prisma: PrismaService) {}

  catalog() {
    return { data: reportCatalog() };
  }

  async run(id: string, query: RunReportQueryDto, user: AuthUser) {
    const { def, ctx } = await this.prepare(id, query, user);
    const result = await def.run(ctx);

    return {
      report: {
        id: def.id,
        name: def.name,
        description: def.description,
        group: def.group,
        filters: def.filters,
        columns: def.columns,
        chart: def.chart ?? null,
        note: def.note ?? null,
      },
      data: result.rows,
      summary: result.summary,
      total: result.total,
      page: ctx.page,
      page_size: ctx.pageSize,
    };
  }

  /**
   * Nguồn đơn có THẬT trong dữ liệu, để dựng bộ lọc "Tất cả nguồn đơn" của màn Tổng quan.
   *
   * Phải hỏi DB chứ không dùng được danh sách nhãn cứng ở frontend: `orders.source_name` là
   * chuỗi tự do, dữ liệu thật có `BAO-HANH`/`Live-FB`/`TDH-Agency-Website` mà bảng nhãn
   * không có (và ngược lại, bảng nhãn có `warranty`/`live_fb`/`sapo` mà không đơn nào dùng).
   * Sắp theo số đơn giảm dần — kênh bán chính nằm ngay đầu danh sách.
   */
  async orderSources(user: AuthUser, locationId?: string) {
    const locationIds = await this.resolveLocations(locationId, user);
    const rows = await this.prisma.$queryRaw<
      { source_name: string; order_count: bigint }[]
    >`
      SELECT o."source_name" AS source_name, COUNT(*) AS order_count
      FROM "orders" o
      WHERE o."location_id" IN (${Prisma.join(locationIds)})
        AND NULLIF(TRIM(o."source_name"), '') IS NOT NULL
      GROUP BY 1
      ORDER BY 2 DESC
    `;
    return {
      data: rows.map((r) => ({
        value: r.source_name,
        order_count: Number(r.order_count),
      })),
    };
  }

  /** Màn "Tổng quan" (trang chủ) — xem `dashboard-overview.report.ts`. */
  async dashboardOverview(query: DashboardOverviewQueryDto, user: AuthUser) {
    const range = query.range ?? 'this_week';
    if (range === 'custom' && !(query.from && query.to)) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Khoảng tuỳ chọn cần truyền đủ cả from và to',
        422,
      );
    }

    const period = resolveDashboardPeriod(range, query.from, query.to);
    if (
      Number.isNaN(period.from.getTime()) ||
      Number.isNaN(period.to.getTime())
    ) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Khoảng thời gian không hợp lệ',
        422,
      );
    }
    if (period.from >= period.to) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Ngày bắt đầu phải trước ngày kết thúc',
        422,
      );
    }

    const locationIds = await this.resolveLocations(query.location_id, user);
    const result = await runDashboardOverview({
      prisma: this.prisma,
      period,
      locationIds,
      channel: query.channel?.trim() || undefined,
      topLimit: DASHBOARD_TOP_PRODUCTS,
      activityLimit: DASHBOARD_ACTIVITY_LIMIT,
    });

    return {
      filters: {
        location_id: query.location_id ?? null,
        channel: query.channel ?? null,
      },
      ...result,
    };
  }

  /** Dashboard "Sản phẩm — Vận hành theo tháng" — xem `product-monthly-ops.report.ts`. */
  async productMonthlyOps(query: ProductMonthlyOpsQueryDto, user: AuthUser) {
    const locationIds = await this.resolveLocations(query.location_id, user);
    const { period, from, to, prevFrom } = this.resolveProductOpsPeriod(query);

    const result = await runProductMonthlyOps({
      prisma: this.prisma,
      from,
      to,
      prevFrom,
      locationIds,
      categoryId: query.category_id ? BigInt(query.category_id) : undefined,
      topLimit: query.top_limit ?? DEFAULT_TOP_LIMIT,
    });

    return {
      period: {
        ...period,
        from: from.toISOString().slice(0, 10),
        to: new Date(to.getTime() - 1).toISOString().slice(0, 10),
      },
      filters: {
        category_id: query.category_id ?? null,
        location_id: query.location_id ?? null,
      },
      ...result,
    };
  }

  async exportExcel(id: string, query: RunReportQueryDto, user: AuthUser) {
    const { def, ctx } = await this.prepare(id, query, user);
    const result = await def.run({ ...ctx, all: true });
    if (result.rows.length > EXPORT_LIMIT) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `Báo cáo có ${result.rows.length} dòng, vượt giới hạn xuất ${EXPORT_LIMIT}. Hãy thu hẹp khoảng thời gian.`,
        422,
      );
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(def.name.slice(0, 31));
    sheet.columns = def.columns.map((c) => ({
      header: c.label,
      key: c.key,
      width: c.type === 'text' ? 28 : 16,
    }));
    for (const row of result.rows)
      sheet.addRow(this.excelRow(def.columns, row));
    // Dòng tổng cuối bảng, in đậm cho khớp cách màn hình hiển thị
    const totalRow = sheet.addRow(this.excelRow(def.columns, result.summary));
    totalRow.font = { bold: true };

    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      filename: `${def.id}.xlsx`,
    };
  }

  /** Excel nhận number thật để còn tính toán được, không phải chuỗi đã format. */
  private excelRow(columns: ReportColumn[], row: ReportRow) {
    const out: Record<string, string | number | null> = {};
    for (const c of columns) {
      const v = row[c.key];
      out[c.key] =
        c.type === 'text' || c.type === 'date' ? (v ?? '') : Number(v ?? 0);
    }
    return out;
  }

  // --- Ghim báo cáo lên màn tổng quan ---

  async listPinned(user: AuthUser) {
    const saved = await this.prisma.savedReport.findMany({
      where: { userId: user.userId, isPinned: true },
      orderBy: { createdAt: 'asc' },
    });
    // Báo cáo có thể bị gỡ khỏi registry giữa các lần deploy — bỏ qua bản ghi mồ côi
    const data = saved
      .map((s) => {
        const def = getReport(s.reportKey);
        if (!def) return null;
        return {
          id: s.id.toString(),
          report_key: s.reportKey,
          name: def.name,
          description: def.description,
          group: def.group,
          chart: def.chart ?? null,
          filters: s.filters ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return { data };
  }

  async pin(id: string, dto: PinReportDto, user: AuthUser) {
    if (!getReport(id)) throw new NotFoundException('Không tìm thấy báo cáo');
    const filters = (dto.filters ?? {}) as Prisma.InputJsonValue;
    await this.prisma.savedReport.upsert({
      where: { userId_reportKey: { userId: user.userId, reportKey: id } },
      create: { userId: user.userId, reportKey: id, filters, isPinned: true },
      update: { filters, isPinned: true },
    });
    return this.listPinned(user);
  }

  async unpin(id: string, user: AuthUser) {
    await this.prisma.savedReport.deleteMany({
      where: { userId: user.userId, reportKey: id },
    });
    return this.listPinned(user);
  }

  // --- Dựng context ---

  private async prepare(
    id: string,
    query: RunReportQueryDto,
    user: AuthUser,
  ): Promise<{ def: ReportDef; ctx: ReportContext }> {
    const def = getReport(id);
    if (!def) throw new NotFoundException('Không tìm thấy báo cáo');

    const locationIds = await this.resolveLocations(query.location_id, user);
    const { from, to } = this.resolveRange(query.from, query.to);

    return {
      def,
      ctx: {
        prisma: this.prisma,
        user,
        locationIds,
        from,
        to,
        bucket: query.bucket ?? 'day',
        channel: query.channel?.trim() || undefined,
        staffId: query.staff_id ? BigInt(query.staff_id) : undefined,
        page: query.page ?? 1,
        pageSize: query.page_size ?? DEFAULT_PAGE_SIZE,
      },
    };
  }

  /**
   * `report:view` là quyền scope=system (xem báo cáo hay không, không theo kho),
   * nên phạm vi dữ liệu ở đây là các kho user ĐƯỢC GÁN — khác các module khác
   * vốn lọc theo kho CÓ QUYỀN. Admin toàn hệ thống thì lấy hết kho.
   *
   * SQL báo cáo dùng `IN (...)` nên phải trả danh sách id thật, không dùng được
   * quy ước `undefined = không lọc` như `locationScopeFilter`.
   */
  private async resolveLocations(
    locationId: string | undefined,
    user: AuthUser,
  ): Promise<bigint[]> {
    if (locationId) {
      const id = BigInt(locationId);
      assertLocationAccess(user, id);
      return [id];
    }
    if (isAdminUser(user)) {
      const all = await this.prisma.location.findMany({ select: { id: true } });
      return all.map((l) => l.id);
    }
    if (!user.locationIds.length) {
      throw new BusinessException(
        'FORBIDDEN_SCOPE',
        'Tài khoản chưa được gán kho nào nên không có dữ liệu báo cáo',
        403,
      );
    }
    return user.locationIds;
  }

  /** `to` là mốc loại trừ (`< to`) nên phải cộng trọn ngày cuối vào khoảng. */
  private resolveRange(from?: string, to?: string) {
    const now = new Date();
    const end = to ? new Date(`${to}T00:00:00`) : now;
    const endExclusive = to
      ? new Date(end.getTime() + 24 * 60 * 60 * 1000)
      : new Date(now.getTime() + 1000);
    const start = from
      ? new Date(`${from}T00:00:00`)
      : new Date(
          endExclusive.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000,
        );

    if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime())) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Khoảng thời gian không hợp lệ',
        422,
      );
    }
    if (start >= endExclusive) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Ngày bắt đầu phải trước ngày kết thúc',
        422,
      );
    }
    return { from: start, to: endExclusive };
  }

  /** Parse "YYYY-MM" → khoảng [đầu tháng, đầu tháng sau) + đầu tháng liền trước (để so sánh). */
  private resolveMonth(month?: string) {
    const now = new Date();
    let year = now.getFullYear();
    let monthIndex = now.getMonth(); // 0-based

    if (month) {
      const m = /^(\d{4})-(\d{2})$/.exec(month);
      if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'Tháng không hợp lệ, định dạng YYYY-MM',
          422,
        );
      }
      year = Number(m[1]);
      monthIndex = Number(m[2]) - 1;
    }

    return {
      period: { year, month: monthIndex + 1 },
      from: new Date(year, monthIndex, 1),
      to: new Date(year, monthIndex + 1, 1),
      prevFrom: new Date(year, monthIndex - 1, 1),
    };
  }

  /** Parse "YYYY-Www" (ISO week) → khoảng [thứ 2, thứ 2 tuần sau) + thứ 2 tuần liền trước. */
  private resolveWeek(week: string) {
    const m = /^(\d{4})-W(\d{2})$/.exec(week);
    const weekNum = m ? Number(m[2]) : NaN;
    if (!m || weekNum < 1 || weekNum > 53) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Tuần không hợp lệ, định dạng YYYY-Www (vd 2026-W32)',
        422,
      );
    }
    const year = Number(m[1]);

    // ISO 8601: tuần 1 là tuần chứa ngày 4/1. Lùi về thứ 2 của tuần đó rồi cộng thêm
    // (weekNum - 1) tuần để ra thứ 2 của tuần cần tìm.
    const jan4 = new Date(year, 0, 4);
    const jan4Weekday = (jan4.getDay() + 6) % 7; // Monday=0 .. Sunday=6
    const week1Monday = new Date(year, 0, 4 - jan4Weekday);
    const from = new Date(
      week1Monday.getFullYear(),
      week1Monday.getMonth(),
      week1Monday.getDate() + (weekNum - 1) * 7,
    );
    const to = new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate() + 7,
    );
    const prevFrom = new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate() - 7,
    );

    return { period: { year, week: weekNum }, from, to, prevFrom };
  }

  /**
   * Chọn đúng 1 kiểu khoảng thời gian cho dashboard "Sản phẩm — Vận hành theo tháng":
   * `day` > `from`+`to` > `week` > `month` (mặc định tháng hiện tại khi không truyền gì).
   * Truyền từ 2 kiểu trở lên, hoặc chỉ 1 trong 2 mốc `from`/`to`, đều là lỗi — tránh áp
   * dụng nhầm bộ lọc mà người dùng không chủ đích chọn.
   */
  private resolveProductOpsPeriod(query: ProductMonthlyOpsQueryDto) {
    const hasRange = Boolean(query.from || query.to);
    if (hasRange && !(query.from && query.to)) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Lọc theo khoảng ngày cần truyền đủ cả from và to',
        422,
      );
    }

    const selected = [query.day, hasRange, query.week, query.month].filter(
      Boolean,
    ).length;
    if (selected > 1) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Chỉ chọn một trong: ngày (day), khoảng ngày (from/to), tuần (week) hoặc tháng (month)',
        422,
      );
    }

    if (query.day) return this.resolveDay(query.day);
    if (hasRange) return this.resolveCustomRange(query.from!, query.to!);
    if (query.week) return this.resolveWeek(query.week);
    return this.resolveMonth(query.month);
  }

  /** Parse "YYYY-MM-DD" → khoảng [ngày đó, ngày kế tiếp) + ngày liền trước (để so sánh). */
  private resolveDay(day: string) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    const year = m ? Number(m[1]) : NaN;
    const monthIndex = m ? Number(m[2]) - 1 : NaN;
    const date = m ? Number(m[3]) : NaN;
    const from = m ? new Date(year, monthIndex, date) : new Date(NaN);
    // `Date` tự cuộn ngày không tồn tại (vd 31/2) sang tháng sau — đối chiếu lại để bắt lỗi này.
    const valid =
      m &&
      !Number.isNaN(from.getTime()) &&
      from.getFullYear() === year &&
      from.getMonth() === monthIndex &&
      from.getDate() === date;
    if (!valid) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Ngày không hợp lệ, định dạng YYYY-MM-DD',
        422,
      );
    }

    return {
      period: { year, month: monthIndex + 1, day: date },
      from,
      to: new Date(year, monthIndex, date + 1),
      prevFrom: new Date(year, monthIndex, date - 1),
    };
  }

  /**
   * Khoảng ngày tuỳ chọn [from, to] (bao gồm `to`) — kỳ trước để so sánh lấy cùng độ dài,
   * liền kề trước `from` (vd chọn 10 ngày thì kỳ trước cũng là 10 ngày ngay trước đó).
   */
  private resolveCustomRange(fromStr: string, toStr: string) {
    const from = new Date(`${fromStr}T00:00:00`);
    const toInclusive = new Date(`${toStr}T00:00:00`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(toInclusive.getTime())) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Khoảng thời gian không hợp lệ',
        422,
      );
    }
    const to = new Date(toInclusive.getTime() + 24 * 60 * 60 * 1000);
    if (from >= to) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Ngày bắt đầu phải trước ngày kết thúc',
        422,
      );
    }
    const prevFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));

    return { period: {}, from, to, prevFrom };
  }
}
