import { Injectable, NotFoundException } from '@nestjs/common';
import {
  InventoryBucket,
  MovementType,
  OrderFulfillmentStatus,
  OrderStatus,
  PackingStatus,
  Prisma,
  ShipmentStatus,
  ShippingProviderType,
} from '@prisma/client';
import { assertAnyLocationAccess } from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { userDisplayName } from '../../common/utils/user-display-name';
import { InventoryService } from '../inventory/inventory.service';
import { sortForLocking } from '../inventory/inventory.types';
import { PrismaService } from '../../prisma/prisma.service';
import { generateFulfillmentCode } from './fulfillment-code';
import {
  CancelFulfillmentDto,
  CarrierWebhookDto,
  CreatePackingDto,
  PushShipmentDto,
  UpdatePackingStatusDto,
  UpdateShipmentStatusDto,
} from './fulfillment.dto';
import {
  fulfillmentInclude,
  serializeFulfillment,
} from './fulfillment.serializer';
import { ShippingProviderService } from './shipping-provider.service';

const DEFAULT_WEIGHT_GRAMS = 500;

type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;

type FulfillmentWithOrder = Prisma.FulfillmentGetPayload<{
  include: { order: { include: { items: true } } };
}>;

@Injectable()
export class FulfillmentService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
    private providers: ShippingProviderService,
  ) {}

  private async loadOrder(orderId: bigint, user: AuthUser): Promise<OrderWithItems> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    assertAnyLocationAccess(user, [order.locationId]);
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
    assertAnyLocationAccess(user, [f.order.locationId]);
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
    const required = new Map<string, { variantId: bigint; locationId: bigint; sku: string; quantity: number }>();
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
          code: await generateFulfillmentCode(tx, order.id, order.code),
          orderId: order.id,
          packingStatus: PackingStatus.cho_dong_goi,
          packerId: dto.packer_id ? BigInt(dto.packer_id) : null,
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
            code: order.code,
            fulfillment_code: record.code,
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
      [PackingStatus.cho_dong_goi]: [
        PackingStatus.cho_dan_phieu,
        PackingStatus.da_dong_goi,
      ],
      [PackingStatus.cho_dan_phieu]: [PackingStatus.da_dong_goi],
      [PackingStatus.da_dong_goi]: [],
    };
    if (!f.packingStatus || !allowed[f.packingStatus]?.includes(dto.status)) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Trạng thái đóng gói không hợp lệ',
        409,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (dto.status === PackingStatus.da_dong_goi) {
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
          packingStatus: dto.status,
          ...(dto.status === PackingStatus.da_dong_goi
            ? { packedAt: new Date() }
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
            code: f.order.code,
            fulfillment_code: f.code,
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
            metadata: { code: f.order.code, fulfillment_code: f.code },
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
      const quoted = this.providers.quoteService(
        provider.servicesConfig,
        dto.service_code,
        weight,
      );
      shippingFee = quoted.fee;
      serviceName = quoted.name;
    }

    const codAmount =
      dto.cod_amount ?? Number(order.totalAmount) - Number(order.paidAmount);

    let location: { name: string; phone: string | null; address: string | null; ward: string | null; district: string | null; province: string | null } | null = null;
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
        shipmentStatus: ShipmentStatus.cho_lay_hang,
        shippingType: dto.shipping_type,
        providerId: provider.id,
        serviceCode: dto.service_code ?? null,
        serviceName,
        trackingCode: dto.tracking_code ?? null,
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
        fromName: dto.from_name ?? location?.name ?? null,
        fromPhone: dto.from_phone ?? location?.phone ?? null,
        fromAddress:
          dto.from_address ??
          (fromAddressParts.length ? fromAddressParts.join(', ') : null),
        pushedAt: new Date(),
      };

      const record = open
        ? await tx.fulfillment.update({ where: { id: open.id }, data: shipmentData })
        : await tx.fulfillment.create({
            data: {
              code: await generateFulfillmentCode(tx, order.id, order.code),
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
            code: order.code,
            fulfillment_code: record.code,
            provider_name: provider.name,
            tracking_code: dto.tracking_code ?? null,
          },
        },
      });
      return record;
    });
    return this.serializeById(created.id);
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
    const allowed: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
      [ShipmentStatus.cho_lay_hang]: [ShipmentStatus.dang_giao],
      [ShipmentStatus.dang_giao]: [
        ShipmentStatus.da_giao,
        ShipmentStatus.giao_loi,
      ],
      [ShipmentStatus.giao_loi]: [
        ShipmentStatus.dang_giao,
        ShipmentStatus.da_hoan,
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

      if (status === ShipmentStatus.dang_giao && !f.pickedUpAt) {
        // ĐTVC lấy hàng: xuất kho — trừ on_hand và giải phóng packing/committed
        const reservedBucket = f.packedAt
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
          data: { shippedAt: now },
        });
        await tx.fulfillment.update({
          where: { id: f.id },
          data: { shipmentStatus: status, pickedUpAt: now },
        });
        await this.logShipment(tx, f, 'fulfillment.picked_up', user);
        return;
      }

      if (status === ShipmentStatus.dang_giao) {
        // Giao lại sau khi giao lỗi — hàng vẫn đang ở ĐTVC, không đụng tồn kho
        await tx.fulfillment.update({
          where: { id: f.id },
          data: { shipmentStatus: status },
        });
        await this.logShipment(tx, f, 'fulfillment.redeliver', user);
        return;
      }

      if (status === ShipmentStatus.da_giao) {
        await tx.fulfillment.update({
          where: { id: f.id },
          data: { shipmentStatus: status, deliveredAt: now, closedAt: now },
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

      if (status === ShipmentStatus.giao_loi) {
        await tx.fulfillment.update({
          where: { id: f.id },
          data: { shipmentStatus: status },
        });
        await this.logShipment(tx, f, 'fulfillment.delivery_failed', user);
        return;
      }

      // da_hoan: hàng về kho — nhập lại on_hand và giữ chỗ committed như trước khi xuất
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
        data: { shippedAt: null },
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
          code: f.order.code,
          fulfillment_code: f.code,
          tracking_code: f.trackingCode,
        },
      },
    });
  }

  async cancel(id: bigint, dto: CancelFulfillmentDto, user: AuthUser) {
    const f = await this.loadFulfillment(id, user);
    if (f.closedAt) {
      throw new BusinessException('INVALID_TRANSITION', 'Phiếu đã đóng', 409);
    }
    if (f.shipmentStatus && f.shipmentStatus !== ShipmentStatus.cho_lay_hang) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Vận đơn đã lấy hàng, không thể hủy',
        409,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (f.packedAt) {
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
          ...(f.shipmentStatus ? { shipmentStatus: ShipmentStatus.huy } : {}),
          cancelledAt: now,
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
            code: f.order.code,
            fulfillment_code: f.code,
            reason: dto.reason ?? null,
          },
        },
      });
    });
    return this.serializeById(id);
  }

  /** Webhook stub — hãng tích hợp gọi về cập nhật trạng thái theo mã vận đơn. */
  async webhook(providerCode: string, dto: CarrierWebhookDto, user: AuthUser) {
    const provider = await this.prisma.shippingProvider.findUnique({
      where: { code: providerCode },
    });
    if (!provider) throw new NotFoundException('Không tìm thấy hãng vận chuyển');

    const status = this.providers.carrierAdapter.mapWebhookStatus(dto.status);
    if (!status) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `Trạng thái không được hỗ trợ: ${dto.status}`,
        422,
      );
    }

    const f = await this.prisma.fulfillment.findFirst({
      where: {
        providerId: provider.id,
        trackingCode: dto.tracking_code,
        closedAt: null,
      },
      include: { order: { include: { items: true } } },
    });
    if (!f) {
      throw new NotFoundException('Không tìm thấy vận đơn theo mã tracking');
    }
    return this.applyShipmentStatus(f, status, user);
  }
}
