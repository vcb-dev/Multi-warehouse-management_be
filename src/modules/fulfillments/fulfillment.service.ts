import { Injectable, NotFoundException } from '@nestjs/common';
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
} from '@prisma/client';
import { assertAnyLocationAccess } from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { userDisplayName } from '../../common/utils/user-display-name';
import { InventoryService } from '../inventory/inventory.service';
import { sortForLocking } from '../inventory/inventory.types';
import { PrismaService } from '../../prisma/prisma.service';
import { GHN_PROVIDER_CODE } from './carriers/carrier-adapter';
import { trackingUrlFor } from './carriers/ghn.client';
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
const DEFAULT_DIM_CM = 10;

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

  private async loadOrder(
    orderId: bigint,
    user: AuthUser,
  ): Promise<OrderWithItems> {
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
    const lengthCm = dto.length_cm ?? DEFAULT_DIM_CM;
    const widthCm = dto.width_cm ?? DEFAULT_DIM_CM;
    const heightCm = dto.height_cm ?? DEFAULT_DIM_CM;
    let shippingFee = dto.shipping_fee ?? 0;
    let serviceName: string | null = null;
    let trackingNumber = dto.tracking_number ?? null;
    let trackingUrl: string | null = null;
    let carrier: string | null = null;
    let carrierName: string | null = null;
    let expectedDeliveryDate: Date | null = null;

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
      // Phí ước tính từ services_config; GHN sẽ ghi đè bằng total_fee thật sau create
      const quoted = this.providers.quoteService(
        provider.servicesConfig,
        dto.service_code,
        weight,
        provider.code,
      );
      shippingFee = quoted.fee;
      serviceName = quoted.name;
    }

    const feePayer = dto.fee_payer ?? ShippingFeePayer.shop_tra;
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
    const originName = dto.origin_name ?? location?.name ?? null;
    const originPhone = dto.origin_phone ?? location?.phone ?? null;
    const originAddress1 =
      dto.origin_address1 ??
      (fromAddressParts.length ? fromAddressParts.join(', ') : null);

    // Đẩy đơn GHN trước khi ghi DB — tránh vận đơn local không có mã tracking
    if (
      dto.shipping_type === ShippingProviderType.tich_hop &&
      provider.code === GHN_PROVIDER_CODE
    ) {
      if (!originName || !originPhone || !originAddress1) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'Thiếu thông tin kho gửi (tên/SĐT/địa chỉ) để tạo đơn GHN',
          422,
        );
      }
      if (!dto.to_ward || !dto.to_district || !dto.to_province) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'Địa chỉ nhận cần đủ phường/quận/tỉnh để tạo đơn GHN',
          422,
        );
      }
      const ghn = this.providers.ghnClientFor(provider.connectionConfig);
      const createdGhn = await ghn.createOrder({
        clientOrderCode: order.name.slice(0, 50),
        fromName: originName,
        fromPhone: originPhone,
        fromAddress: location?.address ?? originAddress1,
        fromWardName: location?.ward ?? undefined,
        fromDistrictName: location?.district ?? undefined,
        fromProvinceName: location?.province ?? undefined,
        toName: dto.to_name,
        toPhone: dto.to_phone,
        toAddress: dto.to_address,
        toWardName: dto.to_ward,
        toDistrictName: dto.to_district,
        toProvinceName: dto.to_province,
        codAmount,
        weightGrams: weight,
        lengthCm,
        widthCm,
        heightCm,
        paymentTypeId: this.providers.ghnAdapter.mapPaymentTypeId(feePayer),
        requiredNote: this.providers.ghnAdapter.mapRequiredNote(
          dto.delivery_requirement,
        ),
        note: dto.note,
        content: order.name,
        insuranceValue: Number(order.totalPrice),
        serviceTypeId: 2,
      });
      trackingNumber = createdGhn.orderCode;
      shippingFee = createdGhn.totalFee;
      trackingUrl = trackingUrlFor(createdGhn.orderCode);
      carrier = 'GHN';
      carrierName = provider.name;
      if (createdGhn.expectedDeliveryTime) {
        const d = new Date(createdGhn.expectedDeliveryTime);
        if (!Number.isNaN(d.getTime())) expectedDeliveryDate = d;
      }
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
        trackingNumber,
        trackingUrl,
        trackingCompany: carrierName,
        carrier,
        carrierName,
        shippingFee,
        feePayer,
        codAmount,
        weightGrams: weight,
        lengthCm,
        widthCm,
        heightCm,
        deliveryRequirement: dto.delivery_requirement,
        note: dto.note,
        toName: dto.to_name,
        toPhone: dto.to_phone,
        toAddress: dto.to_address,
        toWard: dto.to_ward,
        toDistrict: dto.to_district,
        toProvince: dto.to_province,
        locationId,
        originName,
        originPhone,
        originAddress1,
        originWard: location?.ward ?? null,
        originDistrict: location?.district ?? null,
        originProvince: location?.province ?? null,
        expectedDeliveryDate,
        shipmentCreatedOn: new Date(),
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
            tracking_number: trackingNumber,
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

    // Hủy bên GHN trước (nếu đã đẩy); lỗi GHN chặn hủy local để tránh lệch trạng thái
    if (f.trackingNumber && f.providerId) {
      const provider = await this.prisma.shippingProvider.findUnique({
        where: { id: f.providerId },
      });
      if (provider?.code === GHN_PROVIDER_CODE && provider.isConnected) {
        const ghn = this.providers.ghnClientFor(provider.connectionConfig);
        await ghn.cancelOrder([f.trackingNumber]);
      }
    }

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

  /**
   * Webhook ĐTVC. GHN gửi PascalCase (OrderCode/Status); stub cũ dùng snake_case.
   * Luôn cố trả 200 với payload có nghĩa để GHN không retry vô ích khi không tìm thấy đơn.
   */
  async webhook(providerCode: string, dto: CarrierWebhookDto) {
    const provider = await this.prisma.shippingProvider.findUnique({
      where: { code: providerCode },
    });
    if (!provider) {
      return { ok: false, reason: 'provider_not_found' };
    }

    const trackingNumber = (dto.OrderCode ?? dto.tracking_number ?? '').trim();
    const externalStatus = (dto.Status ?? dto.status ?? '').trim();
    if (!trackingNumber || !externalStatus) {
      return { ok: false, reason: 'missing_fields' };
    }

    // Chỉ xử lý tạo mới / đổi trạng thái; bỏ qua update fee/weight/cod
    const eventType = (dto.Type ?? '').toLowerCase();
    if (eventType && eventType !== 'create' && eventType !== 'switch_status') {
      return { ok: true, skipped: true, reason: 'ignored_type' };
    }

    const adapter = this.providers.adapterFor(provider.code);
    const f = await this.prisma.fulfillment.findFirst({
      where: {
        providerId: provider.id,
        trackingNumber,
        closedAt: null,
      },
      include: { order: { include: { items: true } } },
    });
    if (!f) {
      return { ok: false, reason: 'not_found' };
    }

    const actor: AuthUser = {
      userId: f.createdById,
      email: 'webhook@carrier',
      roles: [],
      locationIds: [f.order.locationId],
    };

    // Hủy từ GHN khi còn chờ lấy
    if (
      provider.code === GHN_PROVIDER_CODE &&
      this.providers.ghnAdapter.isCancelStatus(externalStatus)
    ) {
      if (f.shipmentStatus === ShipmentStatus.pending) {
        await this.cancel(f.id, { reason: 'GHN cancel' }, actor);
        return { ok: true, status: ShipmentStatus.cancelled };
      }
      return { ok: true, skipped: true, reason: 'cancel_after_pickup' };
    }

    const target = adapter.mapWebhookStatus(externalStatus);
    if (!target) {
      // ready_to_pick / picking… — chưa cần đổi trạng thái nội bộ
      return { ok: true, skipped: true, reason: 'no_status_change' };
    }
    if (!f.shipmentStatus) {
      return { ok: false, reason: 'no_shipment' };
    }
    if (f.shipmentStatus === target) {
      return { ok: true, skipped: true, reason: 'already_at_status' };
    }

    const path =
      provider.code === GHN_PROVIDER_CODE
        ? this.providers.ghnAdapter.pathTo(f.shipmentStatus, target)
        : [target];
    if (!path) {
      return { ok: true, skipped: true, reason: 'unreachable_status' };
    }

    let current = f;
    try {
      for (const step of path) {
        await this.applyShipmentStatus(current, step, actor);
        const refreshed = await this.prisma.fulfillment.findUnique({
          where: { id: f.id },
          include: { order: { include: { items: true } } },
        });
        if (!refreshed) break;
        current = refreshed;
        if (refreshed.closedAt) break;
      }
    } catch (err) {
      if (err instanceof BusinessException) {
        return {
          ok: false,
          reason: err.code,
          message: err.message,
        };
      }
      throw err;
    }

    return {
      ok: true,
      status: current.shipmentStatus,
      tracking_number: trackingNumber,
    };
  }
}
