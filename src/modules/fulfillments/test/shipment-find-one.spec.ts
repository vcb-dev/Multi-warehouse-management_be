import { ShipmentStatus } from '@prisma/client';
import { adminAuth, staffAuth } from '../../../../test/helpers/auth';
import { FulfillmentService } from '../fulfillment.service';

const now = new Date('2026-01-01');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 10n,
    sapoId: null,
    name: 'FUN1',
    orderId: 2n,
    storeId: null,
    status: 'success',
    packedStatus: 'packed',
    assignedPackerId: null,
    packedOn: now,
    deliveryNotePrintedAt: null,
    shipmentStatus: ShipmentStatus.pending,
    deliveryMethod: 'external_service',
    shipmentCategory: null,
    packageCategory: null,
    shippingType: 'tich_hop',
    providerId: 1n,
    serviceCode: 'VCN',
    serviceName: 'Chuyển phát nhanh',
    trackingNumber: 'VTP123',
    trackingUrl: null,
    trackingCompany: null,
    carrier: 'VIETTEL_POST',
    carrierName: 'Viettel Post',
    trackingNumbers: ['VTP123'],
    trackingUrls: [],
    shippingLabelSlipUrl: null,
    shippingLabelSlipError: null,
    notifyCustomer: false,
    totalQuantity: 1,
    sla: null,
    abnormal: null,
    pickingIssues: null,
    shippingFee: 15000,
    feePayer: 'shop_tra',
    codAmount: 100000,
    codReconciledOn: null,
    weightGrams: 500,
    lengthCm: 15,
    widthCm: 10,
    heightCm: 10,
    deliveryRequirement: null,
    note: null,
    toName: 'An',
    toPhone: '0900000000',
    toAddress: '1 Nguyễn Huệ',
    toWard: 'Bến Nghé',
    toDistrict: null,
    toProvince: 'Hồ Chí Minh',
    locationId: 7n,
    originName: 'Kho A',
    originEmail: null,
    originPhone: '0901111111',
    originAddress1: 'Kho',
    originAddress2: null,
    originWard: null,
    originWardCode: null,
    originDistrict: null,
    originDistrictCode: null,
    originProvince: 'Hồ Chí Minh',
    originProvinceCode: null,
    originCity: null,
    originCountry: 'Việt Nam',
    originCountryCode: null,
    originZipCode: null,
    shipmentCreatedOn: now,
    pickedOn: null,
    sortedOn: null,
    inspectedOn: null,
    issuedOn: null,
    issuedBy: null,
    handedOverAt: null,
    handedBy: null,
    pickedUpAt: null,
    deliveredOn: null,
    expectedDeliveryDate: null,
    orderShipDeadline: null,
    returnedAt: null,
    cancelledOn: null,
    closedAt: null,
    cancelReason: null,
    createdOn: now,
    modifiedOn: now,
    packer: null,
    provider: {
      id: 1n,
      code: 'viettel_post',
      name: 'Viettel Post',
      type: 'tich_hop',
    },
    location: { id: 7n, code: 'A', name: 'Kho A' },
    order: { id: 2n, name: '#1002', locationId: 7n },
    ...over,
  };
}

function svc(prisma: unknown) {
  return new FulfillmentService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('FulfillmentService.findOne', () => {
  it('trả snapshot + mã đơn + đối soát', async () => {
    const prisma = {
      fulfillment: { findUnique: jest.fn().mockResolvedValue(row()) },
    };
    const actual = await svc(prisma).findOne(10n, adminAuth());
    expect(actual.data.name).toBe('FUN1');
    expect(actual.data.tracking_number).toBe('VTP123');
    expect(actual.data.order_name).toBe('#1002');
    expect(actual.data.location_name).toBe('Kho A');
    expect(actual.data.reconciliation_status).toBe('pending');
    expect(actual.data.shipment_status).toBe(ShipmentStatus.pending);
  });

  it('404 khi không có hoặc mới đóng gói chưa đẩy ship', async () => {
    const empty = svc({
      fulfillment: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    await expect(empty.findOne(99n, adminAuth())).rejects.toThrow(
      'Không tìm thấy vận đơn',
    );

    const packing = svc({
      fulfillment: {
        findUnique: jest.fn().mockResolvedValue(row({ shipmentStatus: null })),
      },
    });
    await expect(packing.findOne(10n, adminAuth())).rejects.toThrow(
      'Không tìm thấy vận đơn',
    );
  });

  it('403 khi không có quyền tại kho của vận đơn', async () => {
    const prisma = {
      fulfillment: { findUnique: jest.fn().mockResolvedValue(row()) },
    };
    await expect(
      svc(prisma).findOne(
        10n,
        staffAuth({
          locationIds: [7n],
          warehousePermissions: { '7': ['order:view'] },
        }),
      ),
    ).rejects.toThrow('Bạn không có quyền thao tác tại kho của dữ liệu này.');
  });
});
