import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  InventoryBucket,
  MovementType,
  NotificationTopic,
  OrderFulfillmentStatus,
  OrderStatus,
  PackingStatus,
  Prisma,
  ShipmentStatus,
  ShippingFeePayer,
  ShippingProviderType,
  UserRole,
} from '@prisma/client';
import {
  assertLocationPermission,
  locationScopeFilter,
} from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { userDisplayName } from '../../common/utils/user-display-name';
import { InventoryService } from '../inventory/inventory.service';
import { sortForLocking } from '../inventory/inventory.types';
import { resolveChannelSyncActorUser } from '../channels/channel-sync-actor';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CarrierConnectionConfig,
  CarrierShipmentResult,
} from './carriers/carrier-adapter';
import { generateFulfillmentCode } from './fulfillment-code';
import {
  CancelFulfillmentDto,
  CarrierWebhookDto,
  CreatePackingDto,
  GhnWebhookDto,
  ListShipmentsQueryDto,
  PushShipmentDto,
  ShipmentOverviewQueryDto,
  UpdatePackingStatusDto,
  UpdateShipmentStatusDto,
  VtpWebhookDto,
} from './fulfillment.dto';
import {
  fulfillmentInclude,
  serializeFulfillment,
} from './fulfillment.serializer';
import {
  GHN_PROVIDER_CODE,
  ShippingProviderService,
  VTP_PROVIDER_CODE,
} from './shipping-provider.service';
import {
  serializeShipmentListItem,
  shipmentListInclude,
} from './shipment-list.serializer';

const DEFAULT_WEIGHT_GRAMS = 500;

type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;

type FulfillmentWithOrder = Prisma.FulfillmentGetPayload<{
  include: { order: { include: { items: true } } };
}>;

@Injectable()
export class FulfillmentService {
  private readonly logger = new Logger(FulfillmentService.name);

  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
    private providers: ShippingProviderService,
    private notifications: NotificationService,
  ) {}

  /**
   * Thông báo cho một vận đơn. Gọi SAU khi tx commit, KHÔNG await (emit tự nuốt lỗi).
   * `tracking_code` trong payload là thứ frontend dùng để lọc danh sách vận đơn khi
   * người dùng bấm vào thông báo — xem `resolveLink` ở notification.serializer.ts.
   */
  private notifyFulfillment(
    topic: NotificationTopic,
    f: {
      id: bigint;
      name: string;
      locationId: bigint | null;
      orderId: bigint;
      trackingNumber?: string | null;
      carrierName?: string | null;
    },
    orderName: string,
    title: string,
  ) {
    void this.notifications.emit(topic, {
      subjectType: 'fulfillment',
      subjectId: f.id,
      locationId: f.locationId,
      title,
      payload: {
        code: f.name,
        order_id: f.orderId.toString(),
        order_code: orderName,
        tracking_code: f.trackingNumber ?? f.name,
        carrier_name: f.carrierName ?? null,
      },
    });
  }

  private async loadOrder(
    orderId: bigint,
    user: AuthUser,
  ): Promise<OrderWithItems> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    assertLocationPermission(user, 'order:pack', order.locationId);
    return order;
  }

  private async loadFulfillment(
    id: bigint,
    user: AuthUser,
  ): Promise<FulfillmentWithOrder> {
    const f = await this.prisma.fulfillment.findUnique({
      where: { id },
      include: { order: { include: { items: true } } },
    });
    if (!f) throw new NotFoundException('Không tìm thấy phiếu xử lý đơn hàng');
    assertLocationPermission(user, 'order:pack', f.order.locationId);
    return f;
  }

  /**
   * Đơn hàng được phép "bán âm" (giữ chỗ vượt tồn) khi tạo/đóng gói — điểm
   * chặn thiếu hàng thật chuyển hẳn về đây: ngay khi bấm "Đẩy vận chuyển".
   * Kiểm tra tồn vật lý (on_hand), không dùng available (available đã trừ
   * phần giữ chỗ có thể âm nên không phản ánh đúng "còn bao nhiêu ngoài kho").
   */
  private async assertSufficientPhysicalStock(
    locationId: bigint,
    items: { variantId: bigint; sku: string; quantity: number }[],
  ) {
    const required = new Map<
      string,
      { variantId: bigint; locationId: bigint; sku: string; quantity: number }
    >();
    for (const item of items) {
      const key = `${item.variantId}`;
      const existing = required.get(key);
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        required.set(key, { ...item, locationId });
      }
    }

    const shortages: string[] = [];
    for (const item of required.values()) {
      const level = await this.prisma.inventoryLevel.findUnique({
        where: {
          variantId_locationId: {
            variantId: item.variantId,
            locationId: item.locationId,
          },
        },
      });
      const onHand = level?.onHand ?? 0;
      if (onHand < item.quantity) {
        shortages.push(`${item.sku} (cần ${item.quantity}, còn ${onHand})`);
      }
    }

    if (shortages.length) {
      throw new BusinessException(
        'INSUFFICIENT_STOCK',
        `Không đủ tồn kho thực tế để đẩy vận chuyển: ${shortages.join(', ')}`,
        409,
      );
    }
  }

  private async findOpen(orderId: bigint, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    return client.fulfillment.findFirst({
      where: { orderId, closedAt: null },
    });
  }

  /** Danh sách vận đơn — chỉ bản ghi đã đẩy ship (có shipment_status). */
  async listShipments(query: ListShipmentsQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;

    const where: Prisma.FulfillmentWhereInput = {
      // Chỉ lấy phiếu đã có vận đơn, không lấy phiếu đóng gói thuần
      shipmentStatus: { not: null },
    };

    // Phân quyền theo kho — giống order.list, dùng order:view (khớp ROUTE_PERMISSIONS)
    if (query.location_id) {
      const locationId = BigInt(query.location_id);
      assertLocationPermission(user, 'order:view', locationId);
      where.locationId = locationId;
    } else {
      where.locationId = locationScopeFilter(user, 'order:view');
    }

    // Tab nhanh (ưu tiên tab hơn shipment_status đơn lẻ nếu cả hai có)
    const tab = query.tab?.trim();
    if (tab === 'delivering') {
      where.shipmentStatus = ShipmentStatus.delivering;
    } else if (tab === 'retry_delivery') {
      where.shipmentStatus = ShipmentStatus.retry_delivery;
    } else if (tab === 'returning') {
      where.shipmentStatus = ShipmentStatus.returning;
    } else if (tab === 'delivered') {
      where.shipmentStatus = ShipmentStatus.delivered;
    } else if (tab === 'returned') {
      where.shipmentStatus = ShipmentStatus.returned;
    } else if (tab === 'overdue_10d') {
      // đơn hàng đã được chọn lấy vào kho 10 ngày trước
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      where.shipmentStatus = {
        in: [
          ShipmentStatus.picked_up,
          ShipmentStatus.delivering,
          ShipmentStatus.retry_delivery,
        ],
      };
      where.shipmentCreatedOn = { lte: tenDaysAgo };
    } else if (query.shipment_status) {
      where.shipmentStatus = query.shipment_status as ShipmentStatus;
    }

    if (query.provider_id) {
      where.providerId = BigInt(query.provider_id);
    }

    const q = query.q?.trim();

    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { trackingNumber: { contains: q, mode: 'insensitive' } },
        { toName: { contains: q, mode: 'insensitive' } },
        { order: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.fulfillment.findMany({
        where,
        // sắp xếp theo shipmentCreatedOn, nếu null thì sắp xếp theo createdOn
        // orderBy: { shipmentCreatedOn: 'desc' },
        orderBy: [
          { shipmentCreatedOn: { sort: 'desc', nulls: 'last' } },
          { createdOn: 'desc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: shipmentListInclude,
      }),
      this.prisma.fulfillment.count({ where }),
    ]);

    return {
      data: rows.map(serializeShipmentListItem),
      total,
      page,
      page_size: pageSize,
    };
  }

  /** Đơn có fulfillment đang mở thì các thao tác thủ công cũ bị chặn. */
  async hasOpenFulfillment(orderId: bigint) {
    return (await this.findOpen(orderId)) !== null;
  }

  private async serializeById(id: bigint) {
    const f = await this.prisma.fulfillment.findUniqueOrThrow({
      where: { id },
      include: fulfillmentInclude,
    });
    return serializeFulfillment(f);
  }

  async createPackingRequest(dto: CreatePackingDto, user: AuthUser) {
    const order = await this.loadOrder(BigInt(dto.order_id), user);
    if (order.status !== OrderStatus.open || order.confirmedOn === null) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Xác nhận đơn hàng trước khi tạo yêu cầu đóng gói',
        409,
      );
    }
    await this.assertSufficientPhysicalStock(order.locationId, order.items);
    const created = await this.prisma.$transaction(async (tx) => {
      const open = await this.findOpen(order.id, tx);
      if (open) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Đơn hàng đã có phiếu xử lý đang mở',
          409,
        );
      }
      const record = await tx.fulfillment.create({
        data: {
          name: await generateFulfillmentCode(tx, order.id, order.name),
          orderId: order.id,
          packedStatus: PackingStatus.unknown,
          assignedPackerId: dto.packer_id ? BigInt(dto.packer_id) : null,
          createdById: user.userId,
        },
        include: {
          packer: { select: { firstName: true, lastName: true, email: true } },
        },
      });
      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'fulfillment.packing_request',
          entityType: 'order',
          entityId: order.id,
          metadata: {
            code: order.name,
            fulfillment_code: record.name,
            packer_name: record.packer
              ? (userDisplayName(record.packer) ?? record.packer.email)
              : null,
          },
        },
      });
      return record;
    });
    return this.serializeById(created.id);
  }

  async updatePackingStatus(
    id: bigint,
    dto: UpdatePackingStatusDto,
    user: AuthUser,
  ) {
    const f = await this.loadFulfillment(id, user);
    if (f.closedAt) {
      throw new BusinessException('INVALID_TRANSITION', 'Phiếu đã đóng', 409);
    }
    const allowed: Record<string, PackingStatus[]> = {
      [PackingStatus.unknown]: [PackingStatus.packing, PackingStatus.packed],
      [PackingStatus.packing]: [PackingStatus.packed],
      [PackingStatus.packed]: [],
    };
    if (!f.packedStatus || !allowed[f.packedStatus]?.includes(dto.status)) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Trạng thái đóng gói không hợp lệ',
        409,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (dto.status === PackingStatus.packed) {
        // committed → packed: giữ nguyên available, hàng vào khu đóng gói
        for (const item of sortForLocking(f.order.items)) {
          await this.inventory.applyMovements(
            [
              {
                variantId: item.variantId,
                locationId: f.order.locationId,
                bucket: InventoryBucket.committed,
                change: -item.quantity,
                type: MovementType.packing_start,
                referenceType: 'order',
                referenceId: f.orderId,
                createdById: user.userId,
              },
              {
                variantId: item.variantId,
                locationId: f.order.locationId,
                bucket: InventoryBucket.packed,
                change: item.quantity,
                type: MovementType.packing_start,
                referenceType: 'order',
                referenceId: f.orderId,
                createdById: user.userId,
              },
            ],
            tx,
          );
        }
      }
      await tx.fulfillment.update({
        where: { id },
        data: {
          packedStatus: dto.status,
          ...(dto.status === PackingStatus.packed
            ? { packedOn: new Date() }
            : {}),
        },
      });
      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'fulfillment.packing_status',
          entityType: 'order',
          entityId: f.orderId,
          metadata: {
            code: f.order.name,
            fulfillment_code: f.name,
            status: dto.status,
          },
        },
      });
    });
    return this.serializeById(id);
  }

  async markPrinted(id: bigint, user: AuthUser) {
    const f = await this.loadFulfillment(id, user);
    if (!f.deliveryNotePrintedAt) {
      await this.prisma.$transaction(async (tx) => {
        await tx.fulfillment.update({
          where: { id },
          data: { deliveryNotePrintedAt: new Date() },
        });
        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'fulfillment.print',
            entityType: 'order',
            entityId: f.orderId,
            metadata: { code: f.order.name, fulfillment_code: f.name },
          },
        });
      });
    }
    return this.serializeById(id);
  }

  async pushShipment(dto: PushShipmentDto, user: AuthUser) {
    const order = await this.loadOrder(BigInt(dto.order_id), user);
    if (order.status !== OrderStatus.open || order.confirmedOn === null) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Xác nhận đơn hàng trước khi đẩy vận chuyển',
        409,
      );
    }
    await this.assertSufficientPhysicalStock(order.locationId, order.items);

    const provider = await this.prisma.shippingProvider.findUnique({
      where: { id: BigInt(dto.provider_id) },
    });
    if (!provider || !provider.isActive) {
      throw new NotFoundException('Không tìm thấy đối tác vận chuyển');
    }
    if (provider.type !== dto.shipping_type) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Loại vận chuyển không khớp với đối tác',
        422,
      );
    }

    const weight = dto.weight_grams ?? DEFAULT_WEIGHT_GRAMS;
    let shippingFee = dto.shipping_fee ?? 0;
    let serviceName: string | null = null;

    if (dto.shipping_type === ShippingProviderType.tich_hop) {
      if (!provider.isConnected) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'Hãng vận chuyển chưa được kết nối',
          422,
        );
      }
      if (!dto.service_code) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'Chọn dịch vụ vận chuyển',
          422,
        );
      }
      // Phí tính lại server-side từ cấu hình dịch vụ, bỏ qua phí client gửi lên
      const quoted = await this.providers.quoteService(
        provider.code,
        provider.servicesConfig,
        dto.service_code,
        weight,
      );
      shippingFee = quoted.fee;
      serviceName = quoted.name;
    }

    const codAmount =
      dto.cod_amount ?? Number(order.totalPrice) - Number(order.totalReceived);

    let location: {
      name: string;
      phone: string | null;
      address: string | null;
      ward: string | null;
      district: string | null;
      province: string | null;
    } | null = null;
    const locationId = dto.location_id
      ? BigInt(dto.location_id)
      : order.locationId;
    const branch = await this.prisma.location.findUnique({
      where: { id: locationId },
    });
    if (branch) {
      location = {
        name: branch.name,
        phone: branch.phone,
        address: branch.address1,
        ward: branch.ward,
        district: branch.district,
        province: branch.province,
      };
    }
    const fromAddressParts = [
      location?.address,
      location?.ward,
      location?.district,
      location?.province,
    ].filter(Boolean);
    const originAddress1 =
      dto.origin_address1 ??
      (fromAddressParts.length ? fromAddressParts.join(', ') : null);

    // Gọi API hãng TRƯỚC transaction: nếu hãng lỗi thì không tạo phiếu nào, tránh vận đơn
    // "mồ côi" ở app mà bên hãng không có. Ngược lại (tạo DB trước) thì rollback không xoá
    // được đơn đã sang hãng.
    const carrier = await this.createCarrierShipment({
      provider,
      order,
      dto,
      weight,
      codAmount,
      serviceName,
      origin: {
        name: dto.origin_name ?? location?.name ?? null,
        phone: dto.origin_phone ?? location?.phone ?? null,
        address: originAddress1,
        ward: location?.ward ?? null,
        district: location?.district ?? null,
        province: location?.province ?? null,
      },
    });
    if (carrier) {
      // Phí và ETA THẬT của hãng ghi đè con số ước tính từ services_config
      shippingFee = carrier.shippingFee;
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const open = await this.findOpen(order.id, tx);
      if (open?.shipmentStatus) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Đơn hàng đã có vận đơn đang xử lý',
          409,
        );
      }
      const shipmentData = {
        shipmentStatus: ShipmentStatus.pending,
        shippingType: dto.shipping_type,
        providerId: provider.id,
        serviceCode: dto.service_code ?? null,
        serviceName,
        trackingNumber: carrier?.trackingNumber ?? dto.tracking_number ?? null,
        shippingFee,
        feePayer: dto.fee_payer,
        codAmount,
        weightGrams: weight,
        lengthCm: dto.length_cm,
        widthCm: dto.width_cm,
        heightCm: dto.height_cm,
        deliveryRequirement: dto.delivery_requirement,
        note: dto.note,
        toName: dto.to_name,
        toPhone: dto.to_phone,
        toAddress: dto.to_address,
        toWard: dto.to_ward,
        toDistrict: dto.to_district,
        toProvince: dto.to_province,
        locationId,
        originName: dto.origin_name ?? location?.name ?? null,
        originPhone: dto.origin_phone ?? location?.phone ?? null,
        originAddress1: originAddress1,
        originWard: location?.ward ?? null,
        originDistrict: location?.district ?? null,
        originProvince: location?.province ?? null,
        shipmentCreatedOn: new Date(),
        // Cụm trường Sapo về hãng vận chuyển — chỉ có dữ liệu khi hãng tích hợp API thật
        ...(carrier
          ? {
              trackingUrl: carrier.trackingUrl,
              trackingCompany: carrier.carrierName,
              carrier: carrier.carrier,
              carrierName: carrier.carrierName,
              trackingNumbers: [carrier.trackingNumber],
              trackingUrls: carrier.trackingUrl ? [carrier.trackingUrl] : [],
              expectedDeliveryDate: carrier.expectedDeliveryDate,
            }
          : {}),
      };

      const record = open
        ? await tx.fulfillment.update({
            where: { id: open.id },
            data: shipmentData,
          })
        : await tx.fulfillment.create({
            data: {
              name: await generateFulfillmentCode(tx, order.id, order.name),
              orderId: order.id,
              createdById: user.userId,
              ...shipmentData,
            },
          });

      // Đồng bộ cột "Dịch vụ vận chuyển" ở danh sách đơn
      await tx.order.update({
        where: { id: order.id },
        data: {
          shippingMethod: serviceName
            ? `${provider.name} - ${serviceName}`
            : provider.name,
        },
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'fulfillment.push',
          entityType: 'order',
          entityId: order.id,
          metadata: {
            code: order.name,
            fulfillment_code: record.name,
            provider_name: provider.name,
            tracking_number: shipmentData.trackingNumber,
          },
        },
      });
      return record;
    });

    this.notifyFulfillment(
      NotificationTopic.fulfillments_create,
      created,
      order.name,
      `Vận đơn ${created.name} đã đẩy sang ${provider.name} (đơn ${order.name})`,
    );

    return this.serializeById(created.id);
  }

  /** Tổng quan vận chuyển — dashboard /van-chuyen/tong-quan */
  async getShipmentOverview(query: ShipmentOverviewQueryDto, user: AuthUser) {
    // 1. Base where — chỉ vận đơn đã đẩy ship
    const where: Prisma.FulfillmentWhereInput = {
      shipmentStatus: { not: null },
    };

    // 2. Phân quyền kho (copy từ listShipments)
    if (query.location_id) {
      const locationId = BigInt(query.location_id);
      assertLocationPermission(user, 'order:view', locationId);
      where.locationId = locationId;
    } else {
      where.locationId = locationScopeFilter(user, 'order:view');
    }

    // 3. Khoảng ngày
    const from = query.from
      ? new Date(`${query.from}T00:00:00.000Z`)
      : new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : new Date();

    where.shipmentCreatedOn = { gte: from, lte: to };

    // 4. Thẻ trạng thái — groupBy status
    const statusGroups = await this.prisma.fulfillment.groupBy({
      by: ['shipmentStatus'],
      where,
      _count: { _all: true },
      _sum: { codAmount: true },
    });

    const STATUS_LABELS: Record<string, string> = {
      pending: 'Chờ lấy hàng',
      picked_up: 'Đã lấy hàng',
      delivering: 'Đang giao hàng',
      retry_delivery: 'Chờ giao lại',
      returning: 'Đang hoàn hàng',
      returned: 'Đã hoàn hàng',
      cancelled: 'Đã hủy',
      delivered: 'Đã giao hàng', // không hiện trên dashboard nhưng có thể có
    };

    const statusMap = new Map(
      statusGroups.map((g) => [
        g.shipmentStatus!,
        {
          count: g._count._all,
          cod: Number(g._sum.codAmount ?? 0),
        },
      ]),
    );

    const statusCards = [
      'pending',
      'picked_up',
      'delivering',
      'retry_delivery',
      'returning',
      { key: 'return_pending', label: 'Chờ xác nhận hoàn hàng' }, // tạm 0
      'returned',
    ].map((item) => {
      if (typeof item === 'string') {
        const row = statusMap.get(item as ShipmentStatus);
        return {
          key: item,
          label: STATUS_LABELS[item] ?? item,
          count: row?.count ?? 0,
          cod: row?.cod ?? 0,
          alert: item === 'retry_delivery',
        };
      }
      return {
        key: item.key,
        label: item.label,
        count: 0,
        cod: 0,
      };
    });

    // 5. Tỉ trọng theo provider
    const providerGroups = await this.prisma.fulfillment.groupBy({
      by: ['providerId'],
      where,
      _count: { _all: true },
    });

    const providerIds = providerGroups
      .map((g) => g.providerId)
      .filter((id): id is bigint => id !== null);

    const providers = providerIds.length
      ? await this.prisma.shippingProvider.findMany({
          where: { id: { in: providerIds } },
          select: { id: true, name: true },
        })
      : [];

    const providerName = new Map(
      providers.map((p) => [p.id.toString(), p.name]),
    );

    const proportions = providerGroups.map((g) => ({
      provider_id: g.providerId?.toString() ?? null,
      name: g.providerId
        ? (providerName.get(g.providerId.toString()) ?? 'Không rõ')
        : 'Shipper ngoài',
      count: g._count._all,
    }));

    const totalOrders = proportions.reduce((s, p) => s + p.count, 0);

    // 6. Metrics theo provider — raw SQL cho avg thời gian + success rate
    // ponytail: Prisma groupBy không avg datetime diff dễ; 1 query raw hoặc load subset
    const rows = await this.prisma.fulfillment.findMany({
      where: {
        ...where,
        providerId: { not: null },
      },
      select: {
        providerId: true,
        shipmentStatus: true,
        shipmentCreatedOn: true,
        pickedUpAt: true,
        deliveredOn: true,
        provider: { select: { name: true } },
      },
    });

    type Bucket = {
      name: string;
      pickupMs: number[];
      deliveryMs: number[];
      delivered: number;
      failed: number;
    };

    const buckets = new Map<string, Bucket>();

    for (const r of rows) {
      const pid = r.providerId!.toString();
      const name = r.provider?.name ?? 'Không rõ';
      const b = buckets.get(pid) ?? {
        name,
        pickupMs: [],
        deliveryMs: [],
        delivered: 0,
        failed: 0,
      };

      if (r.pickedUpAt && r.shipmentCreatedOn) {
        b.pickupMs.push(r.pickedUpAt.getTime() - r.shipmentCreatedOn.getTime());
      }
      if (r.deliveredOn && r.pickedUpAt) {
        b.deliveryMs.push(r.deliveredOn.getTime() - r.pickedUpAt.getTime());
      }
      if (r.shipmentStatus === ShipmentStatus.delivered) b.delivered += 1;
      if (
        r.shipmentStatus === ShipmentStatus.returned ||
        r.shipmentStatus === ShipmentStatus.cancelled
      ) {
        b.failed += 1;
      }
      buckets.set(pid, b);
    }

    const avg = (arr: number[]) =>
      arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

    const avgPickupTimes = [...buckets.values()].map((b) => ({
      provider_id: null,
      name: b.name,
      hours: avg(b.pickupMs) ? avg(b.pickupMs)! / (1000 * 60 * 60) : null,
    }));

    const avgDeliveryTimes = [...buckets.values()].map((b) => ({
      provider_id: null,
      name: b.name,
      days: avg(b.deliveryMs)
        ? avg(b.deliveryMs)! / (1000 * 60 * 60 * 24)
        : null,
    }));

    const successRates = [...buckets.values()].map((b) => {
      const total = b.delivered + b.failed;
      return {
        provider_id: null,
        name: b.name,
        rate: total > 0 ? (b.delivered / total) * 100 : 0,
      };
    });

    return {
      status_cards: statusCards,
      avg_pickup_times: avgPickupTimes,
      avg_delivery_times: avgDeliveryTimes,
      success_rates: successRates,
      proportions,
      total_orders: totalOrders,
    };
  }

  /**
   * Tạo vận đơn ở hệ thống hãng. Trả `null` khi hãng chưa tích hợp API (ManualAdapter) —
   * lúc đó mã vận đơn do người dùng tự nhập như trước.
   */
  private async createCarrierShipment(ctx: {
    provider: { code: string; connectionConfig: Prisma.JsonValue };
    order: OrderWithItems;
    dto: PushShipmentDto;
    weight: number;
    codAmount: number;
    serviceName: string | null;
    origin: {
      name: string | null;
      phone: string | null;
      address: string | null;
      ward: string | null;
      district: string | null;
      province: string | null;
    };
  }): Promise<CarrierShipmentResult | null> {
    const { provider, order, dto } = ctx;
    const adapter = this.providers.adapterFor(provider.code);
    if (!adapter.createShipment) return null;

    return adapter.createShipment(
      {
        clientOrderCode: order.name,
        serviceCode: dto.service_code ?? null,
        toName: dto.to_name ?? '',
        toPhone: dto.to_phone ?? '',
        toAddress: dto.to_address ?? '',
        toWard: dto.to_ward ?? null,
        toDistrict: dto.to_district ?? null,
        toProvince: dto.to_province ?? null,
        originName: ctx.origin.name,
        originPhone: ctx.origin.phone,
        originAddress: ctx.origin.address,
        originWard: ctx.origin.ward,
        originDistrict: ctx.origin.district,
        originProvince: ctx.origin.province,
        codAmount: ctx.codAmount,
        // Khai giá trị hàng để hãng bồi thường khi mất/hỏng
        insuranceValue: Number(order.totalPrice),
        // Cột DB mặc định shop_tra khi DTO bỏ trống — giữ nguyên mặc định đó khi gửi sang hãng
        feePayer: dto.fee_payer ?? ShippingFeePayer.shop_tra,
        weightGrams: ctx.weight,
        lengthCm: dto.length_cm ?? null,
        widthCm: dto.width_cm ?? null,
        heightCm: dto.height_cm ?? null,
        deliveryRequirement: dto.delivery_requirement ?? null,
        note: dto.note ?? null,
        items: order.items.map((i) => ({
          name: i.name,
          code: i.sku ?? null,
          quantity: i.quantity,
          price: Number(i.price),
        })),
      },
      (provider.connectionConfig ?? {}) as CarrierConnectionConfig,
    );
  }

  async updateShipmentStatus(
    id: bigint,
    dto: UpdateShipmentStatusDto,
    user: AuthUser,
  ) {
    const f = await this.loadFulfillment(id, user);
    return this.applyShipmentStatus(f, dto.status, user);
  }

  private async applyShipmentStatus(
    f: FulfillmentWithOrder,
    status: ShipmentStatus,
    user: AuthUser,
  ) {
    if (f.closedAt) {
      throw new BusinessException('INVALID_TRANSITION', 'Phiếu đã đóng', 409);
    }
    // Vòng đời vận đơn theo đúng Sapo: pending → picked_up → delivering →
    // delivered, nhánh lỗi retry_delivery → returning → returned. `cancelled` có thể đến từ
    // webhook đối tác vận chuyển (VD VTP hủy đơn bên họ) ở bất kỳ trạng thái nào chưa đóng.
    const allowed: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
      [ShipmentStatus.pending]: [
        ShipmentStatus.picked_up,
        ShipmentStatus.cancelled,
      ],
      [ShipmentStatus.picked_up]: [
        ShipmentStatus.delivering,
        ShipmentStatus.cancelled,
      ],
      [ShipmentStatus.delivering]: [
        ShipmentStatus.delivered,
        ShipmentStatus.retry_delivery,
        ShipmentStatus.cancelled,
      ],
      [ShipmentStatus.retry_delivery]: [
        ShipmentStatus.delivering,
        ShipmentStatus.returning,
        ShipmentStatus.cancelled,
      ],
      [ShipmentStatus.returning]: [
        ShipmentStatus.returned,
        ShipmentStatus.cancelled,
      ],
    };
    if (!f.shipmentStatus || !allowed[f.shipmentStatus]?.includes(status)) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Trạng thái vận đơn không hợp lệ',
        409,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();

      if (status === ShipmentStatus.picked_up) {
        // ĐTVC lấy hàng: xuất kho — trừ on_hand và giải phóng packed/committed
        const reservedBucket = f.packedOn
          ? InventoryBucket.packed
          : InventoryBucket.committed;
        for (const item of sortForLocking(f.order.items)) {
          await this.inventory.applyMovements(
            [
              {
                variantId: item.variantId,
                locationId: f.order.locationId,
                bucket: InventoryBucket.on_hand,
                change: -item.quantity,
                type: MovementType.order_ship,
                referenceType: 'order',
                referenceId: f.orderId,
                createdById: user.userId,
              },
              {
                variantId: item.variantId,
                locationId: f.order.locationId,
                bucket: reservedBucket,
                change: -item.quantity,
                type: MovementType.order_ship,
                referenceType: 'order',
                referenceId: f.orderId,
                createdById: user.userId,
              },
            ],
            tx,
          );
        }
        await tx.order.update({
          where: { id: f.orderId },
          data: { deliveredOn: now },
        });
        await tx.fulfillment.update({
          where: { id: f.id },
          data: { shipmentStatus: status, pickedUpAt: now },
        });
        await this.logShipment(tx, f, 'fulfillment.picked_up', user);
        return;
      }

      if (status === ShipmentStatus.delivering) {
        // Bắt đầu giao / giao lại sau khi lỗi — hàng đang ở ĐTVC, không đụng tồn kho
        await tx.fulfillment.update({
          where: { id: f.id },
          data: { shipmentStatus: status },
        });
        await this.logShipment(tx, f, 'fulfillment.redeliver', user);
        return;
      }

      if (status === ShipmentStatus.delivered) {
        await tx.fulfillment.update({
          where: { id: f.id },
          data: { shipmentStatus: status, deliveredOn: now, closedAt: now },
        });
        await tx.order.update({
          where: { id: f.orderId },
          data: {
            status: OrderStatus.closed,
            closedOn: now,
            completedOn: now,
            fulfillmentStatus: OrderFulfillmentStatus.fulfilled,
          },
        });
        await this.logShipment(tx, f, 'fulfillment.delivered', user);
        return;
      }

      if (status === ShipmentStatus.retry_delivery) {
        await tx.fulfillment.update({
          where: { id: f.id },
          data: { shipmentStatus: status },
        });
        await this.logShipment(tx, f, 'fulfillment.delivery_failed', user);
        return;
      }

      if (status === ShipmentStatus.returning) {
        // ĐTVC đang chuyển hoàn — hàng chưa về tới kho nên chưa nhập lại tồn
        await tx.fulfillment.update({
          where: { id: f.id },
          data: { shipmentStatus: status },
        });
        await this.logShipment(tx, f, 'fulfillment.returning', user);
        return;
      }

      if (status === ShipmentStatus.cancelled) {
        // Hủy do đối tác vận chuyển báo qua webhook (không phải staff bấm hủy trên UI —
        // đường đó đi qua method `cancel()` riêng, đã gọi API hủy bên hãng trước).
        if (f.shipmentStatus === ShipmentStatus.pending) {
          // Chưa xuất kho — trả hàng từ khu đóng gói về giữ chỗ, giống logic `cancel()` thủ công.
          if (f.packedOn) {
            for (const item of sortForLocking(f.order.items)) {
              await this.inventory.applyMovements(
                [
                  {
                    variantId: item.variantId,
                    locationId: f.order.locationId,
                    bucket: InventoryBucket.packed,
                    change: -item.quantity,
                    type: MovementType.packing_cancel,
                    referenceType: 'order',
                    referenceId: f.orderId,
                    createdById: user.userId,
                  },
                  {
                    variantId: item.variantId,
                    locationId: f.order.locationId,
                    bucket: InventoryBucket.committed,
                    change: item.quantity,
                    type: MovementType.packing_cancel,
                    referenceType: 'order',
                    referenceId: f.orderId,
                    createdById: user.userId,
                  },
                ],
                tx,
              );
            }
          }
        } else {
          // Đã xuất kho (qua picked_up) trước khi bị hủy — hoàn on_hand + committed như "returned"
          for (const item of sortForLocking(f.order.items)) {
            await this.inventory.applyMovements(
              [
                {
                  variantId: item.variantId,
                  locationId: f.order.locationId,
                  bucket: InventoryBucket.on_hand,
                  change: item.quantity,
                  type: MovementType.return_in,
                  referenceType: 'order',
                  referenceId: f.orderId,
                  createdById: user.userId,
                },
                {
                  variantId: item.variantId,
                  locationId: f.order.locationId,
                  bucket: InventoryBucket.committed,
                  change: item.quantity,
                  type: MovementType.order_reserve,
                  referenceType: 'order',
                  referenceId: f.orderId,
                  createdById: user.userId,
                },
              ],
              tx,
            );
          }
        }
        await tx.fulfillment.update({
          where: { id: f.id },
          data: {
            shipmentStatus: status,
            cancelledOn: now,
            closedAt: now,
            cancelReason: 'Hủy bởi đối tác vận chuyển (webhook)',
          },
        });
        await this.logShipment(tx, f, 'fulfillment.cancel', user);
        return;
      }

      // returned: hàng đã về tới kho — nhập lại on_hand và giữ chỗ committed như trước khi xuất
      for (const item of sortForLocking(f.order.items)) {
        await this.inventory.applyMovements(
          [
            {
              variantId: item.variantId,
              locationId: f.order.locationId,
              bucket: InventoryBucket.on_hand,
              change: item.quantity,
              type: MovementType.return_in,
              referenceType: 'order',
              referenceId: f.orderId,
              createdById: user.userId,
            },
            {
              variantId: item.variantId,
              locationId: f.order.locationId,
              bucket: InventoryBucket.committed,
              change: item.quantity,
              type: MovementType.order_reserve,
              referenceType: 'order',
              referenceId: f.orderId,
              createdById: user.userId,
            },
          ],
          tx,
        );
      }
      await tx.fulfillment.update({
        where: { id: f.id },
        data: { shipmentStatus: status, returnedAt: now, closedAt: now },
      });
      await tx.order.update({
        where: { id: f.orderId },
        data: { deliveredOn: null },
      });
      await this.logShipment(tx, f, 'fulfillment.returned', user);
    });

    // Đặt ở `applyShipmentStatus` (private) chứ không ở `updateShipmentStatus`: webhook
    // của hãng vận chuyển (webhookGhn/webhookVtp/webhook) cũng đổ về đây, nên gắn một
    // chỗ là phủ được cả trạng thái do hãng tự báo về, không phải rải ra 3 nơi.
    //
    // Chỉ báo 3 mốc đáng quan tâm. picked_up/delivering là diễn biến bình thường của
    // mọi đơn — báo hết thì chuông thành log vận chuyển, không ai đọc nữa.
    const NOTABLE: Partial<Record<ShipmentStatus, string>> = {
      [ShipmentStatus.delivered]: 'giao thành công',
      [ShipmentStatus.returned]: 'đã chuyển hoàn về kho',
      [ShipmentStatus.cancelled]: 'bị hủy',
    };
    const label = NOTABLE[status];
    if (label) {
      this.notifyFulfillment(
        NotificationTopic.fulfillments_update,
        f,
        f.order.name,
        `Vận đơn ${f.name} ${label} (đơn ${f.order.name})`,
      );
    }

    return this.serializeById(f.id);
  }

  private logShipment(
    tx: Prisma.TransactionClient,
    f: FulfillmentWithOrder,
    action: string,
    user: AuthUser,
  ) {
    return tx.activityLog.create({
      data: {
        userId: user.userId,
        action,
        entityType: 'order',
        entityId: f.orderId,
        metadata: {
          code: f.order.name,
          fulfillment_code: f.name,
          tracking_number: f.trackingNumber,
        },
      },
    });
  }

  async cancel(id: bigint, dto: CancelFulfillmentDto, user: AuthUser) {
    const f = await this.loadFulfillment(id, user);
    if (f.closedAt) {
      throw new BusinessException('INVALID_TRANSITION', 'Phiếu đã đóng', 409);
    }
    if (f.shipmentStatus && f.shipmentStatus !== ShipmentStatus.pending) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Vận đơn đã lấy hàng, không thể hủy',
        409,
      );
    }

    // Hủy ở phía hãng TRƯỚC, để không còn cảnh app báo đã hủy mà shipper vẫn đến lấy hàng.
    // Hãng từ chối (đã lấy hàng bên họ) thì dừng luôn, giữ trạng thái nội bộ như cũ.
    await this.cancelCarrierShipment(f);

    await this.prisma.$transaction(async (tx) => {
      if (f.packedOn) {
        // Trả hàng từ khu đóng gói về trạng thái giữ chỗ
        for (const item of sortForLocking(f.order.items)) {
          await this.inventory.applyMovements(
            [
              {
                variantId: item.variantId,
                locationId: f.order.locationId,
                bucket: InventoryBucket.packed,
                change: -item.quantity,
                type: MovementType.packing_cancel,
                referenceType: 'order',
                referenceId: f.orderId,
                createdById: user.userId,
              },
              {
                variantId: item.variantId,
                locationId: f.order.locationId,
                bucket: InventoryBucket.committed,
                change: item.quantity,
                type: MovementType.packing_cancel,
                referenceType: 'order',
                referenceId: f.orderId,
                createdById: user.userId,
              },
            ],
            tx,
          );
        }
      }
      const now = new Date();
      await tx.fulfillment.update({
        where: { id },
        data: {
          ...(f.shipmentStatus
            ? { shipmentStatus: ShipmentStatus.cancelled }
            : {}),
          cancelledOn: now,
          closedAt: now,
          cancelReason: dto.reason,
        },
      });
      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'fulfillment.cancel',
          entityType: 'order',
          entityId: f.orderId,
          metadata: {
            code: f.order.name,
            fulfillment_code: f.name,
            reason: dto.reason ?? null,
          },
        },
      });
    });

    // `cancel()` chạy transaction riêng, KHÔNG đi qua `applyShipmentStatus` — nên trước
    // đây hủy vận đơn bằng tay thì im lặng, còn hãng hủy qua webhook lại có thông báo.
    // Cùng một kết cục với người dùng, phải báo như nhau.
    this.notifyFulfillment(
      NotificationTopic.fulfillments_update,
      f,
      f.order.name,
      `Vận đơn ${f.name} bị hủy (đơn ${f.order.name})`,
    );

    return this.serializeById(id);
  }

  /** Hủy vận đơn bên hãng nếu hãng có API hủy và vận đơn đã có mã thật. */
  private async cancelCarrierShipment(f: FulfillmentWithOrder) {
    if (!f.providerId || !f.trackingNumber) return;
    const provider = await this.prisma.shippingProvider.findUnique({
      where: { id: f.providerId },
    });
    if (!provider) return;

    const adapter = this.providers.adapterFor(provider.code);
    if (!adapter.cancelShipment) return;

    await adapter.cancelShipment(
      f.trackingNumber,
      (provider.connectionConfig ?? {}) as CarrierConnectionConfig,
    );
  }

  /** Webhook mô phỏng — dùng cho hãng chưa tích hợp API thật. */
  async webhook(providerCode: string, dto: CarrierWebhookDto, user: AuthUser) {
    const provider = await this.prisma.shippingProvider.findUnique({
      where: { code: providerCode },
    });
    if (!provider)
      throw new NotFoundException('Không tìm thấy hãng vận chuyển');

    const externalStatus = dto.status ?? '';
    const status = this.providers
      .adapterFor(provider.code)
      .mapWebhookStatus(externalStatus);
    if (!status) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `Trạng thái không được hỗ trợ: ${externalStatus}`,
        422,
      );
    }

    const f = await this.prisma.fulfillment.findFirst({
      where: {
        providerId: provider.id,
        trackingNumber: dto.tracking_number,
        closedAt: null,
      },
      include: { order: { include: { items: true } } },
    });
    if (!f) {
      throw new NotFoundException('Không tìm thấy vận đơn theo mã tracking');
    }
    return this.applyShipmentStatus(f, status, user);
  }

  /**
   * Webhook thật của GHN. GHN không ký request nên xác thực bằng cách đối chiếu `ShopID`
   * với cấu hình kết nối đã lưu.
   *
   * Luôn trả 200 cho mọi tình huống "không có gì để làm" (mã lạ, trạng thái đã đúng, trạng
   * thái GHN không map được): GHN retry 10 lần mỗi 5 giây khi nhận khác 200, sẽ thành bão
   * request cho những ca vô hại.
   */
  async webhookGhn(dto: GhnWebhookDto) {
    const provider = await this.prisma.shippingProvider.findUnique({
      where: { code: GHN_PROVIDER_CODE },
    });
    if (!provider) {
      this.logger.warn('Webhook GHN: chưa có shipping_provider code=ghn');
      return { received: true };
    }

    const config = (provider.connectionConfig ?? {}) as CarrierConnectionConfig;
    if (
      dto.ShopID != null &&
      config.shop_id &&
      String(dto.ShopID) !== String(config.shop_id)
    ) {
      this.logger.warn(
        `Webhook GHN: ShopID ${dto.ShopID} không khớp cấu hình kết nối, bỏ qua`,
      );
      return { received: true };
    }

    const orderCode = dto.OrderCode?.trim();
    if (!orderCode) return { received: true };

    const f = await this.prisma.fulfillment.findFirst({
      where: { providerId: provider.id, trackingNumber: orderCode },
      include: { order: { include: { items: true } } },
      orderBy: { id: 'desc' },
    });
    if (!f) {
      this.logger.warn(`Webhook GHN: không tìm thấy vận đơn ${orderCode}`);
      return { received: true };
    }

    // GHN cân/tính lại kiện hàng — cập nhật số thật để đối soát COD khớp hoá đơn của hãng
    await this.applyGhnMeasurements(f.id, dto);

    if (dto.Type && dto.Type !== 'Switch_status') return { received: true };

    const externalStatus = dto.Status ?? '';
    const ghnAdapter = this.providers.ghnAdapter;

    if (ghnAdapter.isCancelStatus(externalStatus)) {
      if (f.shipmentStatus === ShipmentStatus.pending && !f.closedAt) {
        const user = await this.systemUser();
        await this.cancel(f.id, { reason: 'GHN cancel' }, user);
      }
      return { received: true };
    }

    const status = ghnAdapter.mapWebhookStatus(externalStatus);
    if (!status) {
      this.logger.log(
        `Webhook GHN ${orderCode}: trạng thái "${externalStatus}" chưa map, bỏ qua`,
      );
      return { received: true };
    }
    if (status === f.shipmentStatus || !f.shipmentStatus) {
      return { received: true };
    }

    const path = ghnAdapter.pathTo(f.shipmentStatus, status);
    if (!path) {
      this.logger.warn(
        `Webhook GHN ${orderCode}: không tìm được đường ${f.shipmentStatus} -> ${status}`,
      );
      return { received: true };
    }

    const user = await this.systemUser();
    let current = f;
    try {
      for (const step of path) {
        await this.applyShipmentStatus(current, step, user);
        const refreshed = await this.prisma.fulfillment.findUnique({
          where: { id: f.id },
          include: { order: { include: { items: true } } },
        });
        if (!refreshed) break;
        current = refreshed;
        if (refreshed.closedAt) break;
      }
    } catch (e) {
      // Vòng đời nội bộ chặt hơn GHN (vd nhảy thẳng picked -> delivered). Ghi log để xử lý
      // tay thay vì để GHN retry mãi.
      if (e instanceof BusinessException) {
        this.logger.warn(
          `Webhook GHN ${orderCode}: ${f.shipmentStatus} -> ${status} bị chặn (${e.message})`,
        );
        return { received: true };
      }
      throw e;
    }
    return { received: true };
  }

  /** `Update_weight`/`Update_cod`/`Update_fee` của GHN → cột tương ứng trên fulfillment. */
  private async applyGhnMeasurements(id: bigint, dto: GhnWebhookDto) {
    const data: Prisma.FulfillmentUpdateInput = {};
    if (dto.ConvertedWeight != null && dto.ConvertedWeight > 0) {
      data.weightGrams = Math.round(dto.ConvertedWeight);
    }
    if (dto.CODAmount != null) data.codAmount = dto.CODAmount;
    if (dto.TotalFee != null) data.shippingFee = dto.TotalFee;
    if (dto.Reason || dto.ReasonCode || dto.Warehouse) {
      // Sapo `abnormal` — nơi dành cho ghi chú bất thường của vận đơn
      data.abnormal = {
        reason: dto.Reason ?? null,
        reason_code: dto.ReasonCode ?? null,
        warehouse: dto.Warehouse ?? null,
        at: dto.Time ?? new Date().toISOString(),
      };
    }
    if (Object.keys(data).length === 0) return;
    await this.prisma.fulfillment.update({ where: { id }, data });
  }

  /**
   * Webhook thật của ViettelPost. Payload bọc trong `DATA` (khác GHN phẳng), `ORDER_STATUS` là
   * số (mục 8 tài liệu). Luôn trả `{ received: true }` cho mọi tình huống "không có gì để làm"
   * — VTP đẩy hành trình tuần tự và chỉ dừng khi nhận HTTP 200, kể cả hành trình trùng/thừa/sai
   * thứ tự/đơn lạ sẽ gây bão request nếu trả khác 200 (cùng lý do với `webhookGhn`).
   */
  async webhookVtp(dto: VtpWebhookDto) {
    const provider = await this.prisma.shippingProvider.findUnique({
      where: { code: VTP_PROVIDER_CODE },
    });
    if (!provider) {
      this.logger.warn(
        'Webhook VTP: chưa có shipping_provider code=viettel_post',
      );
      return { received: true };
    }

    const orderNumber =
      typeof dto.DATA?.ORDER_NUMBER === 'string'
        ? dto.DATA.ORDER_NUMBER.trim()
        : undefined;
    const orderReference =
      typeof dto.DATA?.ORDER_REFERENCE === 'string'
        ? dto.DATA.ORDER_REFERENCE.trim()
        : undefined;
    if (!orderNumber) return { received: true };

    let f = await this.prisma.fulfillment.findFirst({
      where: { providerId: provider.id, trackingNumber: orderNumber },
      include: { order: { include: { items: true } } },
      orderBy: { id: 'desc' },
    });

    // Tạo đơn bị lỗi mạng/timeout phía mình nhưng VTP đã tạo thành công bên họ (mục "Lưu ý"
    // mục 7 tài liệu) → chưa kịp lưu trackingNumber nên tra theo mã vận đơn không ra. Fallback
    // qua ORDER_REFERENCE (= order.name, chính là ORDER_NUMBER mình gửi lúc tạo đơn) để backfill.
    if (!f && orderReference) {
      const fallback = await this.prisma.fulfillment.findFirst({
        where: {
          providerId: provider.id,
          closedAt: null,
          order: { name: orderReference },
        },
        include: { order: { include: { items: true } } },
        orderBy: { id: 'desc' },
      });
      if (fallback) {
        f = await this.prisma.fulfillment.update({
          where: { id: fallback.id },
          data: { trackingNumber: orderNumber, trackingNumbers: [orderNumber] },
          include: { order: { include: { items: true } } },
        });
        this.logger.warn(
          `Webhook VTP: backfill trackingNumber ${orderNumber} cho đơn ${orderReference} qua ORDER_REFERENCE`,
        );
      }
    }

    if (!f) {
      this.logger.warn(
        `Webhook VTP: không tìm thấy vận đơn ${orderNumber}` +
          (orderReference ? ` (ref ${orderReference})` : ''),
      );
      return { received: true };
    }

    const rawStatus = dto.DATA?.ORDER_STATUS;
    const status = this.providers
      .adapterFor(VTP_PROVIDER_CODE)
      .mapWebhookStatus(rawStatus != null ? String(rawStatus) : '');
    if (!status) {
      this.logger.log(
        `Webhook VTP ${orderNumber}: trạng thái "${rawStatus}" chưa map, bỏ qua`,
      );
      return { received: true };
    }
    if (status === f.shipmentStatus) return { received: true };

    const user = await this.systemUser();
    try {
      await this.applyShipmentStatus(f, status, user);
    } catch (e) {
      // Vòng đời nội bộ chặt hơn VTP — ghi log để xử lý tay thay vì để VTP retry mãi.
      if (e instanceof BusinessException) {
        this.logger.warn(
          `Webhook VTP ${orderNumber}: ${f.shipmentStatus} -> ${status} bị chặn (${e.message})`,
        );
        return { received: true };
      }
      throw e;
    }
    return { received: true };
  }

  /**
   * Webhook không mang danh tính người dùng nào, nhưng `applyShipmentStatus` cần một
   * `AuthUser` để ghi inventory_movements/activity_logs — dùng admin hệ thống, cùng cách
   * `channel-sync.scheduler.ts` làm cho cron đồng bộ sàn.
   */
  private async systemUser(): Promise<AuthUser> {
    const admin = await resolveChannelSyncActorUser(this.prisma);
    if (!admin) {
      throw new BusinessException(
        'CONFIG_ERROR',
        'Không tìm thấy user đồng bộ hệ thống (CHANNEL_SYNC_ACTOR_* hoặc admin active)',
        500,
      );
    }
    return {
      userId: admin.id,
      email: admin.email,
      roles: admin.roles,
      locationIds: [],
    };
  }
}
