import {
  appendAnd,
  firstDefined,
  parseBool,
  parseDateRange,
  parseEnumList,
  parseIdList,
  parseIntRange,
  parseList,
  textContainsAny,
} from './filter-params';

describe('parseList', () => {
  it('tách dấu phẩy, trim và bỏ phần tử rỗng', () => {
    expect(parseList(' open , closed ,, ')).toEqual(['open', 'closed']);
  });

  it('trả undefined khi không gửi hoặc chỉ toàn rỗng', () => {
    expect(parseList(undefined)).toBeUndefined();
    expect(parseList('')).toBeUndefined();
    expect(parseList(' , , ')).toBeUndefined();
  });
});

describe('parseEnumList', () => {
  const allowed = ['paid', 'pending'] as const;

  it('giữ lại giá trị hợp lệ', () => {
    expect(parseEnumList('paid,pending', allowed)).toEqual(['paid', 'pending']);
  });

  it('trả mảng rỗng (0 dòng) khi mọi giá trị đều rác — không được lờ bộ lọc đi', () => {
    expect(parseEnumList('rac,linh,tinh', allowed)).toEqual([]);
  });

  it('trả undefined khi tham số vắng mặt', () => {
    expect(parseEnumList(undefined, allowed)).toBeUndefined();
  });
});

describe('parseIdList', () => {
  it('đổi sang bigint và bỏ giá trị không phải số nguyên', () => {
    expect(parseIdList('17,42,abc,-3')).toEqual([17n, 42n]);
  });

  it('trả undefined khi không còn id hợp lệ', () => {
    expect(parseIdList('abc,xyz')).toBeUndefined();
  });
});

describe('parseIntRange', () => {
  it('min=0 và max=0 vẫn ra bộ lọc (0 không được coi là vắng mặt)', () => {
    expect(parseIntRange(0, 0)).toEqual({ gte: 0, lte: 0 });
    expect(parseIntRange('0', '0')).toEqual({ gte: 0, lte: 0 });
  });

  it('nhận số âm vì tồn kho âm là dữ liệu có thật', () => {
    expect(parseIntRange('-5', undefined)).toEqual({ gte: -5 });
  });

  it('chỉ một đầu cũng hợp lệ', () => {
    expect(parseIntRange(undefined, 10)).toEqual({ lte: 10 });
  });

  it('trả undefined khi cả hai đầu vắng hoặc rác', () => {
    expect(parseIntRange(undefined, undefined)).toBeUndefined();
    expect(parseIntRange('', '')).toBeUndefined();
    expect(parseIntRange('abc', 'xyz')).toBeUndefined();
  });
});

describe('parseDateRange', () => {
  it('nở YYYY-MM-DD ra trọn ngày theo giờ cửa hàng (+07:00)', () => {
    const range = parseDateRange('2026-08-26', '2026-08-26')!;
    // 00:00 giờ VN ngày 26 = 17:00 UTC ngày 25
    expect(range.gte!.toISOString()).toBe('2026-08-25T17:00:00.000Z');
    // 23:59:59.999 giờ VN ngày 26 = 16:59:59.999 UTC ngày 26
    expect(range.lte!.toISOString()).toBe('2026-08-26T16:59:59.999Z');
  });

  it('bao trọn đơn tạo lúc 20h tối theo giờ VN — ca lỗi nếu quên bù múi giờ', () => {
    const { lte } = parseDateRange(undefined, '2026-08-26')!;
    const donLuc20h = new Date('2026-08-26T13:00:00.000Z'); // 20:00 giờ VN
    expect(donLuc20h.getTime()).toBeLessThanOrEqual(lte!.getTime());
  });

  it('giữ nguyên chuỗi đã có giờ, không nở', () => {
    const { gte } = parseDateRange('2026-08-26T03:30:00.000Z', undefined)!;
    expect(gte!.toISOString()).toBe('2026-08-26T03:30:00.000Z');
  });

  it('trả undefined khi vắng mặt hoặc không parse được', () => {
    expect(parseDateRange(undefined, undefined)).toBeUndefined();
    expect(parseDateRange('hôm qua', 'ngày kia')).toBeUndefined();
  });
});

describe('parseBool', () => {
  it('nhận true/false/1/0', () => {
    expect(parseBool('true')).toBe(true);
    expect(parseBool('1')).toBe(true);
    expect(parseBool('false')).toBe(false);
    expect(parseBool('0')).toBe(false);
  });

  it('bỏ qua giá trị lạ', () => {
    expect(parseBool('có')).toBeUndefined();
    expect(parseBool(undefined)).toBeUndefined();
  });
});

describe('appendAnd', () => {
  it('không đè where.OR đã có', () => {
    const where: { OR?: unknown[]; AND?: unknown } = { OR: [{ name: 'a' }] };
    appendAnd(where, { status: 'open' });
    expect(where.OR).toEqual([{ name: 'a' }]);
    expect(where.AND).toEqual([{ status: 'open' }]);
  });

  it('cộng dồn nhiều mệnh đề thay vì ghi đè', () => {
    const where: { AND?: unknown } = {};
    appendAnd(where, { a: 1 });
    appendAnd(where, { b: 2 });
    expect(where.AND).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('bọc AND dạng object đơn lẻ thành mảng', () => {
    const where: { AND?: unknown } = { AND: { a: 1 } };
    appendAnd(where, { b: 2 });
    expect(where.AND).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('firstDefined', () => {
  it('ưu tiên tên mới, rơi về tên cũ khi tên mới vắng', () => {
    expect(firstDefined(undefined, '2026-08-01')).toBe('2026-08-01');
    expect(firstDefined('moi', 'cu')).toBe('moi');
  });

  it('coi chuỗi rỗng như vắng mặt', () => {
    expect(firstDefined('', 'cu')).toBe('cu');
    expect(firstDefined('', '')).toBeUndefined();
  });
});

describe('textContainsAny', () => {
  it('nhiều giá trị nối bằng HOẶC, không phân biệt hoa thường', () => {
    expect(textContainsAny('vendor', ['HuyK', 'Vân Phong Các'])).toEqual({
      OR: [
        { vendor: { contains: 'HuyK', mode: 'insensitive' } },
        { vendor: { contains: 'Vân Phong Các', mode: 'insensitive' } },
      ],
    });
  });

  it('khớp một phần — gõ thiếu chữ vẫn ra kết quả', () => {
    const clause = textContainsAny('vendor', ['huy']);
    expect(clause.OR[0].vendor.contains).toBe('huy');
    expect(clause.OR[0].vendor.mode).toBe('insensitive');
  });
});
