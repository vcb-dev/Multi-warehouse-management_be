import { computeAvailable } from '../src/modules/inventory/inventory.types';

describe('INV-1 available formula', () => {
  it('available = on_hand - committed - packing - unavailable', () => {
    expect(
      computeAvailable({
        onHand: 10,
        committed: 3,
        packed: 2,
        unavailable: 1,
      }),
    ).toBe(4);
  });

  it('committed reserve reduces available without changing on_hand', () => {
    const onHand = 10;
    const available = computeAvailable({
      onHand,
      committed: 3,
      packed: 0,
      unavailable: 0,
    });
    expect(onHand).toBe(10);
    expect(available).toBe(7);
  });
});
