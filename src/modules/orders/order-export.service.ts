import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  EXPORT_ROW_LIMIT,
  ExportField,
  describeFields,
  exportFilename,
  resolveFields,
  singleBatch,
  streamXlsx,
  vnDateTime,
} from '../../common/utils/xlsx-export';
import { userDisplayName } from '../../common/utils/user-display-name';
import { carrierDisplayName } from '../fulfillments/carrier-display';
import { ExportOrdersQueryDto, ORDER_EXPORT_MODES } from './order.dto';
import { OrderRepository } from './order.repository';
import { OrderService } from './order.service';

export type OrderExportMode = (typeof ORDER_EXPORT_MODES)[number];

/**
 * Số đơn nạp mỗi lượt truy vấn khi stream.
 *
 * Để lô nhỏ là bẫy hiệu năng: Prisma bắn thêm một query cho MỖI quan hệ trong
 * `include` ở mỗi lô, nên chi phí là (số lô × ~6 round-trip) tới DB ở xa.
 * Đo xuất trọn 50.000 đơn trên Supabase thật: lô 300 → ~130s, lô 2000 → ~48s,
 * lô 5000 → ~31s. Dừng ở 5000 vì lợi ích đã giảm dần mà RAM thì tăng tuyến tính.
 */
const BATCH_SIZE = 5000;

const exportInclude = {
  customer: {
    select: { firstName: true, lastName: true, phone: true, email: true },
  },
  location: { select: { name: true } },
  createdBy: { select: { firstName: true, lastName: true, email: true } },
  assignedTo: { select: { firstName: true, lastName: true, email: true } },
  items: {
    select: {
      name: true,
      variantTitle: true,
      sku: true,
      quantity: true,
      price: true,
      totalDiscount: true,
      discountedTotal: true,
      variant: { select: { unit: true } },
    },
  },
  fulfillments: {
    orderBy: { id: 'desc' },
    take: 1,
    select: {
      trackingNumber: true,
      shipmentStatus: true,
      packedStatus: true,
      shippingFee: true,
      codAmount: true,
      provider: { select: { name: true } },
      carrierName: true,
      trackingCompany: true,
      carrier: true,
    },
  },
} satisfies Prisma.OrderInclude;

type ExportOrder = Prisma.OrderGetPayload<{ include: typeof exportInclude }>;
type ExportItem = ExportOrder['items'][number];

/**
 * Một dòng của file. `item` = null ở loại "tổng quan theo đơn" (mỗi đơn 1 dòng);
 * ở "file chi tiết" mỗi dòng hàng là một dòng file, các cột cấp đơn lặp lại.
 */
type OrderRow = { index: number; order: ExportOrder; item: ExportItem | null };

const STATUS_LABEL: Record<string, string> = {
  open: 'Đang xử lý',
  closed: 'Đã hoàn thành',
  cancelled: 'Đã hủy',
};

const FINANCIAL_LABEL: Record<string, string> = {
  pending: 'Chưa thanh toán',
  partially_paid: 'Thanh toán một phần',
  paid: 'Đã thanh toán',
  refunded: 'Đã hoàn tiền',
  partially_refunded: 'Hoàn tiền một phần',
  voided: 'Đã hủy thanh toán',
};

const FULFILLMENT_LABEL: Record<string, string> = {
  fulfilled: 'Đã giao hàng',
  partial: 'Giao một phần',
  unfulfilled: 'Chưa giao hàng',
  received: 'Đã nhận hàng',
  returned: 'Đã trả hàng',
};

function num(v: Prisma.Decimal | null | undefined): number {
  return v == null ? 0 : Number(v);
}

function customerName(o: ExportOrder): string {
  if (!o.customer) return '';
  return [o.customer.firstName, o.customer.lastName].filter(Boolean).join(' ');
}

function shippingAddress(o: ExportOrder): string {
  return [
    o.shippingAddress1,
    o.shippingWard,
    o.shippingDistrict,
    o.shippingProvince,
  ]
    .filter((p) => p?.trim())
    .join(', ');
}

const G_ORDER = 'Thông tin đơn hàng';
const G_CUSTOMER = 'Thông tin khách hàng';
const G_SHIPPING = 'Thông tin giao hàng';
const G_MONEY = 'Thông tin thanh toán';
const G_PRODUCT = 'Thông tin sản phẩm';

/**
 * Trường cấp đơn — dùng chung cho "tổng quan theo đơn" và "file chi tiết".
 * `default: true` là bộ cột mặc định, khớp panel phải trong dialog Sapo.
 */
const ORDER_FIELDS: ExportField<OrderRow>[] = [
  {
    key: 'stt',
    header: 'STT',
    group: G_ORDER,
    width: 8,
    locked: true,
    default: true,
    value: (r) => r.index,
  },
  {
    key: 'code',
    header: 'Mã đơn hàng',
    group: G_ORDER,
    width: 22,
    locked: true,
    default: true,
    value: (r) => r.order.name,
  },
  {
    key: 'id',
    header: 'ID đơn hàng',
    group: G_ORDER,
    width: 16,
    value: (r) => r.order.id.toString(),
  },
  {
    key: 'created_on',
    header: 'Ngày tạo đơn',
    group: G_ORDER,
    width: 18,
    value: (r) => vnDateTime(r.order.createdOn),
  },
  {
    key: 'ordered_at',
    header: 'Ngày đặt hàng',
    group: G_ORDER,
    width: 18,
    default: true,
    value: (r) => vnDateTime(r.order.createdOn),
  },
  {
    key: 'confirmed_on',
    header: 'Ngày xác nhận',
    group: G_ORDER,
    width: 18,
    value: (r) => vnDateTime(r.order.confirmedOn),
  },
  {
    key: 'completed_on',
    header: 'Ngày hoàn thành',
    group: G_ORDER,
    width: 18,
    value: (r) => vnDateTime(r.order.completedOn),
  },
  {
    key: 'cancelled_on',
    header: 'Hủy đơn hàng lúc',
    group: G_ORDER,
    width: 18,
    value: (r) => vnDateTime(r.order.cancelledOn),
  },
  {
    key: 'location',
    header: 'Chi nhánh',
    group: G_ORDER,
    width: 22,
    default: true,
    value: (r) => r.order.location.name,
  },
  {
    key: 'source',
    header: 'Nguồn',
    group: G_ORDER,
    width: 16,
    default: true,
    value: (r) => r.order.sourceName ?? '',
  },
  {
    key: 'created_by',
    header: 'Nhân viên tạo đơn',
    group: G_ORDER,
    width: 22,
    default: true,
    value: (r) => userDisplayName(r.order.createdBy) ?? r.order.createdBy.email,
  },
  {
    key: 'assigned_to',
    header: 'Nhân viên phụ trách',
    group: G_ORDER,
    width: 22,
    value: (r) =>
      r.order.assignedTo
        ? (userDisplayName(r.order.assignedTo) ?? r.order.assignedTo.email)
        : '',
  },
  {
    key: 'status',
    header: 'Trạng thái đơn hàng',
    group: G_ORDER,
    width: 18,
    default: true,
    value: (r) => STATUS_LABEL[r.order.status] ?? r.order.status,
  },
  {
    key: 'financial_status',
    header: 'Trạng thái thanh toán',
    group: G_ORDER,
    width: 20,
    value: (r) =>
      FINANCIAL_LABEL[r.order.financialStatus] ?? r.order.financialStatus,
  },
  {
    key: 'fulfillment_status',
    header: 'Trạng thái giao hàng',
    group: G_ORDER,
    width: 20,
    value: (r) =>
      r.order.fulfillmentStatus
        ? (FULFILLMENT_LABEL[r.order.fulfillmentStatus] ??
          r.order.fulfillmentStatus)
        : 'Chưa giao hàng',
  },
  {
    key: 'return_status',
    header: 'Trạng thái trả hàng',
    group: G_ORDER,
    width: 18,
    value: (r) => r.order.returnStatus,
  },
  {
    key: 'note',
    header: 'Ghi chú',
    group: G_ORDER,
    width: 30,
    default: true,
    value: (r) => r.order.note ?? '',
  },
  {
    key: 'tags',
    header: 'Tags',
    group: G_ORDER,
    width: 24,
    default: true,
    value: (r) => r.order.tags.join(', '),
  },

  {
    key: 'customer_name',
    header: 'Tên khách hàng',
    group: G_CUSTOMER,
    width: 24,
    default: true,
    value: (r) => customerName(r.order),
  },
  {
    key: 'customer_email',
    header: 'Email',
    group: G_CUSTOMER,
    width: 24,
    default: true,
    value: (r) => r.order.email ?? r.order.customer?.email ?? '',
  },
  {
    key: 'customer_phone',
    header: 'Số điện thoại',
    group: G_CUSTOMER,
    width: 16,
    default: true,
    value: (r) => r.order.phone ?? r.order.customer?.phone ?? '',
  },

  {
    key: 'shipping_name',
    header: 'Người nhận',
    group: G_SHIPPING,
    width: 24,
    value: (r) =>
      r.order.shippingName ??
      [r.order.shippingFirstName, r.order.shippingLastName]
        .filter(Boolean)
        .join(' '),
  },
  {
    key: 'shipping_phone',
    header: 'SĐT người nhận',
    group: G_SHIPPING,
    width: 16,
    value: (r) => r.order.shippingPhone ?? '',
  },
  {
    key: 'shipping_address',
    header: 'Địa chỉ giao hàng',
    group: G_SHIPPING,
    width: 40,
    value: (r) => shippingAddress(r.order),
  },
  {
    key: 'shipping_province',
    header: 'Tỉnh/Thành phố',
    group: G_SHIPPING,
    width: 20,
    value: (r) => r.order.shippingProvince ?? '',
  },
  {
    key: 'shipping_district',
    header: 'Quận/Huyện',
    group: G_SHIPPING,
    width: 20,
    value: (r) => r.order.shippingDistrict ?? '',
  },
  {
    key: 'shipping_ward',
    header: 'Phường/Xã',
    group: G_SHIPPING,
    width: 20,
    value: (r) => r.order.shippingWard ?? '',
  },
  {
    key: 'tracking_number',
    header: 'Mã vận đơn',
    group: G_SHIPPING,
    width: 22,
    value: (r) => r.order.fulfillments[0]?.trackingNumber ?? '',
  },
  {
    key: 'carrier',
    header: 'Hãng vận chuyển',
    group: G_SHIPPING,
    width: 20,
    value: (r) => {
      const f = r.order.fulfillments[0];
      return f ? (carrierDisplayName(f) ?? '') : '';
    },
  },
  {
    key: 'shipping_method',
    header: 'Dịch vụ vận chuyển',
    group: G_SHIPPING,
    width: 20,
    value: (r) => r.order.shippingMethod ?? '',
  },
  {
    key: 'delivery_note',
    header: 'Ghi chú giao hàng',
    group: G_SHIPPING,
    width: 30,
    value: (r) => r.order.deliveryNote ?? '',
  },

  {
    key: 'total_quantity',
    header: 'Tổng số lượng sản phẩm',
    group: G_MONEY,
    width: 20,
    default: true,
    value: (r) => r.order.subtotalLineItemsQuantity,
  },
  {
    key: 'sub_total',
    header: 'Tiền hàng',
    group: G_MONEY,
    width: 16,
    value: (r) => num(r.order.subTotalPrice),
  },
  {
    key: 'total_discounts',
    header: 'Chiết khấu',
    group: G_MONEY,
    width: 16,
    value: (r) => num(r.order.totalDiscounts),
  },
  {
    key: 'total_shipping',
    header: 'Phí vận chuyển',
    group: G_MONEY,
    width: 16,
    value: (r) => num(r.order.totalShippingPrice),
  },
  {
    key: 'total_tax',
    header: 'Thuế',
    group: G_MONEY,
    width: 14,
    value: (r) => num(r.order.totalTax),
  },
  {
    key: 'total',
    header: 'Tổng tiền',
    group: G_MONEY,
    width: 16,
    default: true,
    value: (r) => num(r.order.totalPrice),
  },
  {
    key: 'total_received',
    header: 'Đã thanh toán',
    group: G_MONEY,
    width: 16,
    value: (r) => num(r.order.totalReceived),
  },
  {
    key: 'unpaid_amount',
    header: 'Còn phải trả',
    group: G_MONEY,
    width: 16,
    value: (r) => num(r.order.unpaidAmount),
  },
  {
    key: 'cod_amount',
    header: 'Tiền thu hộ (COD)',
    group: G_MONEY,
    width: 18,
    value: (r) => num(r.order.fulfillments[0]?.codAmount),
  },
  {
    key: 'gateway',
    header: 'Phương thức thanh toán',
    group: G_MONEY,
    width: 22,
    value: (r) => r.order.gateway ?? '',
  },
];

/** Trường cấp dòng hàng — chỉ có ở "File chi tiết" */
const ITEM_FIELDS: ExportField<OrderRow>[] = [
  {
    key: 'item_name',
    header: 'Tên sản phẩm',
    group: G_PRODUCT,
    width: 40,
    default: true,
    value: (r) => r.item?.name ?? '',
  },
  {
    key: 'item_sku',
    header: 'Mã SKU',
    group: G_PRODUCT,
    width: 22,
    default: true,
    value: (r) => r.item?.sku ?? '',
  },
  {
    key: 'item_variant',
    header: 'Phiên bản',
    group: G_PRODUCT,
    width: 22,
    value: (r) => r.item?.variantTitle ?? '',
  },
  {
    key: 'item_unit',
    header: 'Đơn vị tính',
    group: G_PRODUCT,
    width: 14,
    value: (r) => r.item?.variant?.unit ?? '',
  },
  {
    key: 'item_quantity',
    header: 'Số lượng sản phẩm',
    group: G_PRODUCT,
    width: 16,
    default: true,
    value: (r) => r.item?.quantity ?? 0,
  },
  {
    key: 'item_price',
    header: 'Giá sản phẩm',
    group: G_PRODUCT,
    width: 16,
    default: true,
    value: (r) => num(r.item?.price),
  },
  {
    key: 'item_discount',
    header: 'Chiết khấu sản phẩm',
    group: G_PRODUCT,
    width: 18,
    value: (r) => num(r.item?.totalDiscount),
  },
  {
    key: 'item_total',
    header: 'Thành tiền sản phẩm',
    group: G_PRODUCT,
    width: 18,
    value: (r) => num(r.item?.discountedTotal),
  },
];

/** Dòng của "File tổng quan theo sản phẩm" — gộp mọi dòng hàng theo SKU */
type ProductRow = {
  index: number;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  revenue: number;
  discount: number;
  orders: number;
};

const PRODUCT_FIELDS: ExportField<ProductRow>[] = [
  {
    key: 'stt',
    header: 'STT',
    group: G_PRODUCT,
    width: 8,
    locked: true,
    default: true,
    value: (r) => r.index,
  },
  {
    key: 'sku',
    header: 'Mã SKU',
    group: G_PRODUCT,
    width: 22,
    locked: true,
    default: true,
    value: (r) => r.sku,
  },
  {
    key: 'name',
    header: 'Tên sản phẩm',
    group: G_PRODUCT,
    width: 40,
    default: true,
    value: (r) => r.name,
  },
  {
    key: 'unit',
    header: 'Đơn vị tính',
    group: G_PRODUCT,
    width: 14,
    default: true,
    value: (r) => r.unit,
  },
  {
    key: 'quantity',
    header: 'Số lượng bán',
    group: G_PRODUCT,
    width: 16,
    default: true,
    value: (r) => r.quantity,
  },
  {
    key: 'orders',
    header: 'Số đơn hàng',
    group: G_PRODUCT,
    width: 14,
    default: true,
    value: (r) => r.orders,
  },
  {
    key: 'discount',
    header: 'Chiết khấu',
    group: G_PRODUCT,
    width: 16,
    value: (r) => r.discount,
  },
  {
    key: 'revenue',
    header: 'Doanh thu',
    group: G_PRODUCT,
    width: 18,
    default: true,
    value: (r) => r.revenue,
  },
];

/** Catalog của hai loại file dựng từ đơn; loại `product` dùng PRODUCT_FIELDS riêng */
function orderCatalog(mode: 'order' | 'detail'): ExportField<OrderRow>[] {
  return mode === 'detail' ? [...ORDER_FIELDS, ...ITEM_FIELDS] : ORDER_FIELDS;
}

@Injectable()
export class OrderExportService {
  constructor(
    private orders: OrderService,
    private repo: OrderRepository,
  ) {}

  /** Danh sách trường cho dialog "Tùy chọn trường dữ liệu xuất" */
  fields(mode: OrderExportMode) {
    return {
      data:
        mode === 'product'
          ? describeFields(PRODUCT_FIELDS)
          : describeFields(orderCatalog(mode)),
    };
  }

  async export(
    query: ExportOrdersQueryDto,
    user: AuthUser,
    res: Response,
  ): Promise<void> {
    const mode: OrderExportMode = query.mode ?? 'order';
    const where = await this.buildExportWhere(query, user);

    if (mode === 'product') {
      const rows = await this.aggregateByProduct(where);
      await streamXlsx(res, {
        filename: exportFilename('don-hang-theo-san-pham'),
        sheetName: 'San pham',
        fields: resolveFields(PRODUCT_FIELDS, query.fields),
        batches: singleBatch(rows),
      });
      return;
    }

    await streamXlsx(res, {
      filename: exportFilename(
        mode === 'detail' ? 'don-hang-chi-tiet' : 'don-hang',
      ),
      sheetName: 'Don hang',
      fields: resolveFields(orderCatalog(mode), query.fields),
      batches: this.orderRows(where, mode),
    });
  }

  /** Trải đơn thành dòng file: loại `detail` bung mỗi dòng hàng thành một dòng */
  private async *orderRows(
    where: Prisma.OrderWhereInput,
    mode: 'order' | 'detail',
  ): AsyncGenerator<OrderRow[]> {
    let index = 0;
    for await (const orders of this.iterateOrders(where)) {
      const rows: OrderRow[] = [];
      for (const order of orders) {
        if (mode === 'detail' && order.items.length) {
          for (const item of order.items) {
            rows.push({ index: ++index, order, item });
          }
        } else {
          rows.push({ index: ++index, order, item: null });
        }
      }
      yield rows;
    }
  }

  /**
   * Bộ lọc của file xuất. Ưu tiên `ids` (phạm vi "N đơn được chọn" / "đơn trên
   * trang này" — FE gửi thẳng id đang hiển thị) rồi mới tới bộ lọc màn hình,
   * để file luôn khớp đúng thứ người dùng thấy.
   */
  private async buildExportWhere(
    query: ExportOrdersQueryDto,
    user: AuthUser,
  ): Promise<Prisma.OrderWhereInput> {
    const where = await this.orders.buildListWhere(query, user);

    const ids = (query.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length) {
      // Vẫn giữ where gốc để không vượt quyền kho: id chỉ thu hẹp thêm.
      return { AND: [where, { id: { in: ids.map((id) => BigInt(id)) } }] };
    }

    const stockFilter =
      query.stock_status === 'thieu_hang' || query.stock_status === 'du_hang'
        ? query.stock_status
        : undefined;
    if (stockFilter) {
      const matched = await this.orders.filterByStockStatus(where, stockFilter);
      return { AND: [where, { id: { in: matched } }] };
    }

    return where;
  }

  /**
   * Phân trang keyset theo (createdOn, id) giảm dần — cùng thứ tự với bảng
   * danh sách. Dùng keyset thay vì skip/take vì offset sâu (chục nghìn đơn)
   * làm Postgres phải quét lại từ đầu mỗi lô.
   */
  private async *iterateOrders(
    where: Prisma.OrderWhereInput,
  ): AsyncGenerator<ExportOrder[]> {
    let cursor: { createdOn: Date; id: bigint } | null = null;
    let fetched = 0;

    while (fetched < EXPORT_ROW_LIMIT) {
      const keyset: Prisma.OrderWhereInput | null = cursor
        ? {
            OR: [
              { createdOn: { lt: cursor.createdOn } },
              { createdOn: cursor.createdOn, id: { lt: cursor.id } },
            ],
          }
        : null;

      const batch: ExportOrder[] = await this.repo.client.order.findMany({
        where: keyset ? { AND: [where, keyset] } : where,
        orderBy: [{ createdOn: 'desc' }, { id: 'desc' }],
        take: BATCH_SIZE,
        include: exportInclude,
      });
      if (!batch.length) return;

      fetched += batch.length;
      const last = batch[batch.length - 1];
      cursor = { createdOn: last.createdOn, id: last.id };
      yield batch;

      if (batch.length < BATCH_SIZE) return;
    }
  }

  /** Gộp dòng hàng theo SKU cho "File tổng quan theo sản phẩm" */
  private async aggregateByProduct(
    where: Prisma.OrderWhereInput,
  ): Promise<ProductRow[]> {
    const acc = new Map<
      string,
      Omit<ProductRow, 'index'> & { orderIds: Set<string> }
    >();

    for await (const orders of this.iterateOrders(where)) {
      for (const order of orders) {
        for (const item of order.items) {
          const key = item.sku || item.name;
          let entry = acc.get(key);
          if (!entry) {
            entry = {
              sku: item.sku,
              name: item.name,
              unit: item.variant?.unit ?? '',
              quantity: 0,
              revenue: 0,
              discount: 0,
              orders: 0,
              orderIds: new Set(),
            };
            acc.set(key, entry);
          }
          entry.quantity += item.quantity;
          entry.revenue += num(item.discountedTotal);
          entry.discount += num(item.totalDiscount);
          entry.orderIds.add(order.id.toString());
        }
      }
    }

    return Array.from(acc.values())
      .sort((a, b) => b.quantity - a.quantity)
      .map(({ orderIds, ...row }, i) => ({
        ...row,
        orders: orderIds.size,
        index: i + 1,
      }));
  }
}
