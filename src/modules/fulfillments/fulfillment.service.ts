import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  InventoryBucket,
  MovementType,
  OrderFulfillmentStatus,
  OrderStatus,
  PackingStatus,
  Prisma,
  ShipmentStatus,
  ShippingFeePayer,
  ShippingProviderType,
  UserRole,
} from '@prisma/client';
import { assertLocationPermission } from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { userDisplayName } from '../../common/utils/user-display-name';
import { InventoryService } from '../inventory/inventory.service';
import { sortForLocking } from '../inventory/inventory.types';
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
  PushShipmentDto,
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
  ) {}

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
    return this.serializeById(created.id);
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
    // delivered, nhánh lỗi retry_delivery → returning → returned.
    const allowed: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
      [ShipmentStatus.pending]: [ShipmentStatus.picked_up],
      [ShipmentStatus.picked_up]: [ShipmentStatus.delivering],
      [ShipmentStatus.delivering]: [
        ShipmentStatus.delivered,
        ShipmentStatus.retry_delivery,
      ],
      [ShipmentStatus.retry_delivery]: [
        ShipmentStatus.delivering,
        ShipmentStatus.returning,
      ],
      [ShipmentStatus.returning]: [ShipmentStatus.returned],
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
    const admin = await this.prisma.user.findFirst({
      where: { email: 'admin@local.dev', active: true },
    });
    if (!admin) {
      throw new BusinessException(
        'CONFIG_ERROR',
        'Không tìm thấy tài khoản hệ thống admin@local.dev để ghi nhận webhook',
        500,
      );
    }
    return {
      userId: admin.id,
      email: admin.email,
      roles: [UserRole.admin],
      locationIds: [],
    };
  }
}
