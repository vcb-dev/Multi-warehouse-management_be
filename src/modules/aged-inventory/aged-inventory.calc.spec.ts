import {
  agedQty,
  colorFromSku,
  daysSince,
  fifoLayers,
  isJewelryGroup,
  orderSoldQty,
  pickImage,
  pickSizeColor,
  productGroup,
  salesWindow,
  sizeFromSku,
  variantTitle,
  vnDateKey,
} from './aged-inventory.calc';

const d = (iso: string) => new Date(iso);

describe('productGroup / isJewelryGroup', () => {
  it('lấy phần trước ">>" và so khớp chính xác nhóm trang sức', () => {
    expect(productGroup('NHẪN >> Bạc')).toBe('NHẪN');
    expect(productGroup('VÒNG >> Trầm hương')).toBe('VÒNG');
    expect(productGroup('MẶT DÂY CHUYỀN >> Bạc Thái')).toBe('MẶT DÂY CHUYỀN');
    expect(isJewelryGroup(productGroup('VÒNG >> Trầm hương'))).toBe(true);
    expect(isJewelryGroup(productGroup('ĐÁ QUÝ'))).toBe(true);
    expect(isJewelryGroup(productGroup('MẶT LẮC TAY'))).toBe(true);
  });

  it('loại CHARM, CHARM DA, quà tặng, túi xách và product_type rỗng', () => {
    expect(isJewelryGroup(productGroup('CHARM >> Bạc'))).toBe(false);
    expect(isJewelryGroup(productGroup('Charm Da'))).toBe(false);
    expect(isJewelryGroup(productGroup('VẬT PHẨM, QUÀ TẶNG'))).toBe(false);
    expect(isJewelryGroup(productGroup('Túi Xách Nữ'))).toBe(false);
    expect(isJewelryGroup(productGroup(null))).toBe(false);
    expect(isJewelryGroup(productGroup(''))).toBe(false);
  });

  it('chịu được chữ thường, khoảng trắng thừa và chuỗi NFD', () => {
    expect(productGroup('  bông   tai >> Vàng')).toBe('BÔNG TAI');
    expect(
      isJewelryGroup(productGroup('NHẪN'.normalize('NFD') + ' >> Bạc')),
    ).toBe(true);
  });
});

describe('pickSizeColor', () => {
  it('map option theo position sang size/màu, không phân biệt dấu/hoa thường', () => {
    const options = [
      { name: 'Màu Sắc', position: 2 },
      { name: 'Kích thước', position: 1 },
    ];
    expect(
      pickSizeColor(options, {
        option1: 'Size 6',
        option2: 'Trắng',
        option3: null,
      }),
    ).toEqual({ size: 'Size 6', color: 'Trắng' });
    expect(
      pickSizeColor(
        [
          { name: 'size', position: 1 },
          { name: 'màu đá', position: 2 },
        ],
        {
          option1: '9.5',
          option2: 'Xanh',
          option3: null,
        },
      ),
    ).toEqual({ size: '9.5', color: 'Xanh' });
  });

  it('bỏ placeholder Title/Default Title và option không phải size/màu', () => {
    expect(
      pickSizeColor([{ name: 'Title', position: 1 }], {
        option1: 'Default Title',
        option2: null,
        option3: null,
      }),
    ).toEqual({ size: null, color: null });
    expect(
      pickSizeColor([{ name: 'Hoạ tiết', position: 1 }], {
        option1: 'Hoa',
        option2: null,
        option3: null,
      }),
    ).toEqual({ size: null, color: null });
  });
});

describe('sizeFromSku / colorFromSku (quy ước mã mới)', () => {
  it('đọc màu từ đuôi SKU, mã lạ trả nguyên ký hiệu', () => {
    expect(colorFromSku('N0001-05-S-WH')).toBe('Trắng');
    expect(colorFromSku('B0030-00-S-YL')).toBe('Vàng');
    expect(colorFromSku('N0001-05-G18-PK')).toBe('Hồng');
    expect(colorFromSku('N0001-05-S-ZZ')).toBe('ZZ');
  });

  it('không đoán với mã kiểu cũ hoặc mã thiếu màu', () => {
    expect(colorFromSku('N700426')).toBeNull();
    expect(colorFromSku('B400271-3')).toBeNull();
    expect(colorFromSku('N9001-00-S')).toBeNull();
    expect(colorFromSku(null)).toBeNull();
    expect(sizeFromSku('N700426', 'NHẪN')).toBeNull();
  });

  it('đọc size các dạng đã khớp với option thật', () => {
    expect(sizeFromSku('D0031-00-S-WH', 'DÂY CHUYỀN')).toBe('Free size');
    expect(sizeFromSku('N0088-06-S-WH', 'NHẪN')).toBe('6');
    expect(sizeFromSku('N0001-12-S-WH', 'NHẪN')).toBe('12');
    expect(sizeFromSku('N0028-65-S-WH', 'NHẪN')).toBe('6.5');
    expect(sizeFromSku('N0028-95-S-WH', 'NHẪN')).toBe('9.5');
    expect(sizeFromSku('L0001-17-S-WH', 'LẮC')).toBe('17 cm');
    expect(sizeFromSku('D0001-45-S-WH', 'DÂY CHUYỀN')).toBe('45 cm');
    expect(sizeFromSku('K0002-54-S-WH', 'KIỀNG')).toBe('54 mm');
    expect(sizeFromSku('N9001-00-S', 'NHẪN')).toBe('Free size');
  });

  it('để trống các mã mơ hồ', () => {
    // Lắc nửa cm dùng số thứ tự: L0014-03 thật ra là 16.5 cm.
    expect(sizeFromSku('L0014-03-S-WH', 'LẮC')).toBeNull();
    // Nhẫn 10.5 ghi "15".
    expect(sizeFromSku('N0031-15-S-WH', 'NHẪN')).toBeNull();
    expect(sizeFromSku('B0001-50-S-WH', 'BÔNG TAI')).toBeNull();
  });
});

describe('variantTitle / pickImage', () => {
  it('Default Title → null', () => {
    expect(variantTitle('Default Title')).toBeNull();
    expect(variantTitle('Size 5')).toBe('Size 5');
  });

  it('ưu tiên ảnh phiên bản, rơi về ảnh sản phẩm', () => {
    const product = {
      image: { id: 1, product_id: 9, position: 1, src: 'p.jpg' },
      images: [
        { id: 1, product_id: 9, position: 1, src: 'p.jpg' },
        { id: 2, product_id: 9, position: 2, src: 'v.jpg' },
      ],
    };
    expect(pickImage(product, { image_id: 2 })).toBe('v.jpg');
    expect(pickImage(product, { image_id: null })).toBe('p.jpg');
    expect(pickImage(product, { image_id: 999 })).toBe('p.jpg');
    expect(
      pickImage({ image: null, images: [] }, { image_id: null }),
    ).toBeNull();
  });
});

describe('vnDateKey / daysSince', () => {
  it('tính theo lịch VN (UTC+7)', () => {
    // 18h UTC ngày 16 = 1h sáng ngày 17 giờ VN.
    expect(vnDateKey(d('2026-10-16T18:00:00Z'))).toBe('2026-10-17');
    expect(daysSince(d('2026-10-16T18:00:00Z'), '2026-10-17')).toBe(0);
    expect(daysSince(d('2026-09-17T03:00:00Z'), '2026-10-17')).toBe(30);
  });
});

describe('salesWindow / orderSoldQty', () => {
  it('30 ngày lịch VN tròn trước ngày snapshot, không gồm hôm nay', () => {
    const { min, max } = salesWindow('2026-10-17', 30);
    expect(max.toISOString()).toBe('2026-10-16T17:00:00.000Z'); // 0h 17/10 VN
    expect(min.toISOString()).toBe('2026-09-16T17:00:00.000Z'); // 0h 17/09 VN
  });

  it('cộng current_quantity theo phiên bản, bỏ dòng deleted', () => {
    const sold = orderSoldQty({
      status: 'open',
      line_items: [
        { variant_id: 1, quantity: 2, current_quantity: 2 },
        { variant_id: 1, quantity: 1, current_quantity: 1 },
        { variant_id: 2, quantity: 3, current_quantity: 1 }, // trả 2
        { variant_id: 3, quantity: 1, current_quantity: 0 }, // trả hết
        { variant_id: 4, quantity: 5, current_quantity: 5, deleted: true },
        { variant_id: 5, quantity: 2 }, // thiếu current_quantity
      ],
    });
    expect([...sold]).toEqual([
      [1, 3],
      [2, 1],
      [5, 2],
    ]);
  });

  it('đơn huỷ không tính', () => {
    const lines = [{ variant_id: 1, quantity: 1, current_quantity: 1 }];
    expect(orderSoldQty({ status: 'cancelled', line_items: lines }).size).toBe(
      0,
    );
    expect(
      orderSoldQty({
        status: 'open',
        cancelled_on: '2026-10-01T00:00:00Z',
        line_items: lines,
      }).size,
    ).toBe(0);
  });
});

describe('fifoLayers', () => {
  const asOf = '2026-10-17';

  it('đủ phiếu nhập: lớp lấy từ các phiếu MỚI NHẤT, phiếu cũ coi như đã bán', () => {
    const layers = fifoLayers(
      3,
      [
        { receivedOn: d('2026-07-01T03:00:00Z'), qty: 5 },
        { receivedOn: d('2026-10-07T03:00:00Z'), qty: 2 },
        { receivedOn: d('2026-08-03T03:00:00Z'), qty: 4 },
      ],
      d('2025-09-10T00:00:00Z'),
    );
    expect(layers).toEqual([
      { since: d('2026-10-07T03:00:00Z'), qty: 2, source: 'receipt' },
      { since: d('2026-08-03T03:00:00Z'), qty: 1, source: 'receipt' },
    ]);
    expect(daysSince(layers.at(-1)!.since, asOf)).toBe(75);
    expect(agedQty(layers, 30, asOf)).toBe(1);
    expect(agedQty(layers, 0, asOf)).toBe(3);
  });

  it('thiếu phiếu: phần dư thành lớp "created" theo ngày tạo phiên bản', () => {
    const layers = fifoLayers(
      4,
      [{ receivedOn: d('2026-10-01T03:00:00Z'), qty: 1 }],
      d('2025-09-10T00:00:00Z'),
    );
    expect(layers).toEqual([
      { since: d('2026-10-01T03:00:00Z'), qty: 1, source: 'receipt' },
      { since: d('2025-09-10T00:00:00Z'), qty: 3, source: 'created' },
    ]);
    expect(agedQty(layers, 30, asOf)).toBe(3);
  });

  it('không có phiếu nào: toàn bộ tính từ ngày tạo', () => {
    expect(fifoLayers(2, [], d('2026-08-01T02:35:26Z'))).toEqual([
      { since: d('2026-08-01T02:35:26Z'), qty: 2, source: 'created' },
    ]);
  });

  it('lớp "created" không bao giờ muộn hơn phiếu cũ nhất đã dùng', () => {
    const layers = fifoLayers(
      3,
      [{ receivedOn: d('2026-03-01T00:00:00Z'), qty: 1 }],
      d('2026-08-01T00:00:00Z'),
    );
    expect(layers.at(-1)).toEqual({
      since: d('2026-03-01T00:00:00Z'),
      qty: 2,
      source: 'created',
    });
  });

  it('tồn <= 0 → không có lớp nào; phiếu qty <= 0 bị bỏ', () => {
    expect(
      fifoLayers(0, [{ receivedOn: d('2026-01-01'), qty: 3 }], d('2025-01-01')),
    ).toEqual([]);
    expect(
      fifoLayers(1, [{ receivedOn: d('2026-10-01'), qty: 0 }], d('2025-09-10')),
    ).toEqual([{ since: d('2025-09-10'), qty: 1, source: 'created' }]);
  });
});
