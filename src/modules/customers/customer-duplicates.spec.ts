import {
  canMatchAddress,
  canMatchName,
  compareDuplicates,
  isSameAddress,
  isSimilarAddressLine,
  nameKey,
  phoneKey,
  placeKey,
} from './customer-duplicates';

describe('phoneKey', () => {
  it('quy mọi cách viết của cùng một số về 0xxxxxxxxx', () => {
    for (const raw of [
      '+84977346440',
      '84977346440',
      '977346440',
      '0977 346 440',
      '0977.346.440',
    ]) {
      expect(phoneKey(raw)).toBe('0977346440');
    }
  });

  it('giữ nguyên số nước ngoài và chuỗi rỗng', () => {
    expect(phoneKey('+12048807865')).toBe('12048807865');
    expect(phoneKey('')).toBe('');
    expect(phoneKey(null)).toBe('');
  });
});

describe('nameKey', () => {
  it('bỏ dấu, hoa/thường và khoảng trắng thừa', () => {
    expect(nameKey('  Nguyễn   Thị Hà ')).toBe('nguyen thi ha');
    expect(nameKey('NGUYEN THI HA')).toBe('nguyen thi ha');
  });

  it('bỏ danh xưng đứng đầu tên', () => {
    expect(nameKey('Chị Nguyễn Thị Hà')).toBe('nguyen thi ha');
    expect(nameKey('anh Huỳnh Văn Giao')).toBe('huynh van giao');
    expect(nameKey('A. Tuấn Anh')).toBe('tuan anh');
  });

  it('bỏ danh xưng Sapo đặt riêng ở last_name', () => {
    expect(nameKey('Lan Phượng', 'Chị')).toBe('lan phuong');
    expect(nameKey('nguyễn văn hải', 'Anh')).toBe('nguyen van hai');
  });

  it('giữ "Anh" khi là tên thật ở cuối và "Chu" khi là họ', () => {
    expect(nameKey('Anh Ngô Việt Anh')).toBe('ngo viet anh');
    expect(nameKey('Chu Văn An')).toBe('chu van an');
  });

  it('không bóc hết khi tên chỉ còn danh xưng', () => {
    expect(nameKey('Anh')).toBe('anh');
  });
});

describe('canMatchName', () => {
  it('tên một chữ không đủ làm tín hiệu trùng', () => {
    expect(canMatchName(nameKey('Chị Hà'))).toBe(false);
    expect(canMatchName(nameKey('Trần Mùi'))).toBe(true);
  });
});

describe('placeKey', () => {
  it('danh mục hành chính và cách viết Sapo cho ra cùng khoá', () => {
    expect(placeKey('Thành phố Hà Nội')).toBe(placeKey('Hà Nội'));
    expect(placeKey('Thành phố Hồ Chí Minh')).toBe(placeKey('TP Hồ Chí Minh'));
    expect(placeKey('Tỉnh Nam Định')).toBe(placeKey('Nam Định'));
    expect(placeKey('Thị xã Tân Uyên')).toBe(placeKey('Thành phố Tân Uyên'));
    expect(placeKey('P. La Khê')).toBe(placeKey('Phường La Khê'));
  });

  it('không nuốt chữ cái đầu của tên địa danh', () => {
    expect(placeKey('Hà Nội')).toBe('ha noi');
    expect(placeKey('Xã Giao Xuân')).toBe('giao xuan');
  });
});

describe('isSimilarAddressLine', () => {
  it('coi thêm/bớt chữ "số", "đường" là cùng địa chỉ', () => {
    expect(isSimilarAddressLine('Số 10 đường Gò Dầu', '10 Gò Dầu')).toBe(true);
    expect(
      isSimilarAddressLine('171 Trường Chinh 12', '171 Trường Chinh'),
    ).toBe(true);
  });

  it('khác số nhà là khác địa chỉ', () => {
    expect(
      isSimilarAddressLine('Số 12 đường Gò Dầu', 'Số 10 đường Gò Dầu'),
    ).toBe(false);
  });

  it('khác đường là khác địa chỉ', () => {
    expect(isSimilarAddressLine('10 Gò Dầu', '10 Lũy Bán Bích')).toBe(false);
  });

  it('dòng địa chỉ quá ngắn không đủ để kết luận', () => {
    expect(isSimilarAddressLine('Thôn', 'Thôn Hoàng Môn')).toBe(false);
  });
});

describe('isSameAddress', () => {
  const existing = {
    address1: 'Số 10 đường  Gò Dầu',
    ward: 'Phường Tân Sơn Nhì',
    district: 'Quận Tân Phú',
    province: 'TP Hồ Chí Minh',
  };

  it('khớp khi cùng phường, tỉnh và dòng địa chỉ', () => {
    expect(
      isSameAddress(
        {
          address1: '10 Gò Dầu',
          ward: 'Phường Tân Sơn Nhì',
          district: 'Quận Tân Phú',
          province: 'Thành phố Hồ Chí Minh',
        },
        existing,
      ),
    ).toBe(true);
  });

  it('bỏ qua quận/huyện khi một bên không có (địa chỉ sau sáp nhập)', () => {
    expect(
      isSameAddress(
        {
          address1: '10 Gò Dầu',
          ward: 'Phường Tân Sơn Nhì',
          province: 'Hồ Chí Minh',
        },
        existing,
      ),
    ).toBe(true);
  });

  it('dòng địa chỉ chỉ chép lại tên phường/quận không tính là trùng', () => {
    const daiMo = {
      ward: 'Phường Đại Mỗ',
      district: 'Quận Nam Từ Liêm',
      province: 'Hà Nội',
    };
    expect(
      isSameAddress(
        { ...daiMo, address1: 'Số 12 ngách 2 ngõ 91 Đại Mỗ' },
        { ...daiMo, address1: 'Đại Mỗ' },
      ),
    ).toBe(false);
    expect(
      isSameAddress(
        { ...daiMo, address1: 'Số 12 ngách 2 ngõ 91 Đại Mỗ' },
        { ...daiMo, address1: '12 Ngách 2 Ngõ 91 Đại Mỗ, phường Đại Mỗ' },
      ),
    ).toBe(true);
  });

  it('không khớp khi khác phường hoặc khác quận', () => {
    expect(
      isSameAddress({ ...existing, ward: 'Phường Tân Quý' }, existing),
    ).toBe(false);
    expect(
      isSameAddress({ ...existing, district: 'Quận Tân Bình' }, existing),
    ).toBe(false);
  });

  it('cần đủ phường, tỉnh và dòng địa chỉ mới so', () => {
    expect(canMatchAddress({ address1: '10 Gò Dầu', province: 'Hà Nội' })).toBe(
      false,
    );
    expect(canMatchAddress(existing)).toBe(true);
  });
});

describe('compareDuplicates', () => {
  it('trùng SĐT lên đầu, rồi đến số tiêu chí khớp, rồi số đơn', () => {
    const rows = [
      { id: 'name-many-orders', matched: ['name' as const], orders_count: 50 },
      {
        id: 'name-address',
        matched: ['name' as const, 'address' as const],
        orders_count: 1,
      },
      { id: 'phone', matched: ['phone' as const], orders_count: 0 },
      { id: 'address', matched: ['address' as const], orders_count: 3 },
    ];
    expect(rows.sort(compareDuplicates).map((r) => r.id)).toEqual([
      'phone',
      'name-address',
      'name-many-orders',
      'address',
    ]);
  });
});
