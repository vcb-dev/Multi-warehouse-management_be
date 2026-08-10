import { classify } from './inventory-nxt.service';

describe('InventoryNxtService classify()', () => {
  it('xếp C - TỒN XẤU khi không bán được cái nào trong 30 ngày, bất kể tồn', () => {
    expect(classify(0, 0)).toMatchObject({ code: 'C', isr: null });
    expect(classify(0, 500)).toMatchObject({ code: 'C', isr: null });
  });

  it('xếp A1/A2/A3 khi bán chạy (ban30 >= 30) theo ISR tăng dần', () => {
    expect(classify(30, 30)).toMatchObject({ code: 'A1' }); // isr = 1
    expect(classify(30, 60)).toMatchObject({ code: 'A2' }); // isr = 2
    expect(classify(30, 90)).toMatchObject({ code: 'A3' }); // isr = 3
  });

  it('xếp B1/B2 khi bán chậm (ban30 < 30) theo ISR', () => {
    expect(classify(10, 15)).toMatchObject({ code: 'B1' }); // isr = 1.5
    expect(classify(10, 20)).toMatchObject({ code: 'B2' }); // isr = 2
  });

  it('isr tính đúng bằng onHand / ban30', () => {
    const { isr } = classify(30, 45);
    expect(isr).toBeCloseTo(1.5);
  });
});
