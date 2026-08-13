#!/usr/bin/env ts-node
/**
 * Backfill MỘT LẦN: sinh order_reserve cho các đơn Sapo đang open/chưa
 * fulfilled mà lịch sử KHÔNG được sync-new-sapo-orders ghi committed (lỗ hổng
 * đã vá cho đơn MỚI ở sync-new-sapo-orders.ts — script này xử lý phần tồn
 * đọng trước đó).
 *
 * Idempotent: bỏ qua mọi đơn đã có ít nhất 1 movement
 *   type='order_reserve' AND reference_type='order' AND reference_id=<order.id>
 *
 * Đơn có ít nhất 1 dòng fulfillable_quantity khác quantity (đã giao dở dang
 * bên Sapo trước khi biết tới đơn) bị TÁCH RIÊNG, KHÔNG tự động ghi — in ra
 * danh sách để xử lý tay, vì fulfillment.service.ts luôn trừ committed theo
 * quantity gốc (không theo fulfillable_quantity) khi ĐTVC lấy hàng.
 *
 * LƯU Ý: chạy scripts/refresh-order-statuses.js --apply TRƯỚC script này, để
 * đảm bảo tập đơn "open" đang xét thật sự còn mở theo Sapo hiện tại.
 *
 * Chạy thử:  npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-order-reserve.ts
 * Ghi thật:  npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-order-reserve.ts --apply
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, InventoryBucket, MovementType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { sortForLocking } from '../src/modules/inventory/inventory.types';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const MOVEMENT_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };
const CHUNK = 500;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const inventory = app.get(InventoryService);

  // BƯỚC 1: tập mục tiêu — đơn Sapo còn "open" và chưa fulfilled hoàn toàn.
  const orders = await prisma.order.findMany({
    where: {
      status: 'open',
      sapoId: { not: null },
      OR: [{ fulfillmentStatus: null }, { fulfillmentStatus: { not: 'fulfilled' } }],
    },
    select: {
      id: true,
      name: true,
      sapoId: true,
      locationId: true,
      fulfillmentStatus: true,
      items: { select: { variantId: true, quantity: true, fulfillableQuantity: true, sku: true } },
    },
    orderBy: { id: 'asc' },
  });
  console.log(`Tập mục tiêu: ${orders.length} đơn, ${orders.reduce((n, o) => n + o.items.length, 0)} dòng hàng`);

  // BƯỚC 2: idempotency — loại đơn đã có order_reserve từ trước.
  const alreadyReserved = new Set<string>();
  for (let i = 0; i < orders.length; i += CHUNK) {
    const ids = orders.slice(i, i + CHUNK).map((o) => o.id);
    const rows = await prisma.inventoryMovement.findMany({
      where: { type: MovementType.order_reserve, referenceType: 'order', referenceId: { in: ids } },
      select: { referenceId: true },
      distinct: ['referenceId'],
    });
    rows.forEach((r) => r.referenceId != null && alreadyReserved.add(String(r.referenceId)));
  }
  console.log(`Đã có order_reserve từ trước (bỏ qua): ${alreadyReserved.size}`);

  // BƯỚC 3: phân loại — auto-apply vs cần review tay.
  const toApply: typeof orders = [];
  const needReview: { order: (typeof orders)[number]; reason: string }[] = [];

  for (const o of orders) {
    if (alreadyReserved.has(String(o.id))) continue;
    if (!o.items.length) {
      needReview.push({ order: o, reason: 'không có dòng hàng nào (order_items rỗng)' });
      continue;
    }
    const partialFulfilled = o.items.filter(
      (i) => i.fulfillableQuantity != null && i.fulfillableQuantity !== i.quantity,
    );
    if (partialFulfilled.length) {
      needReview.push({
        order: o,
        reason: `${partialFulfilled.length} dòng fulfillable_quantity ≠ quantity (${partialFulfilled
          .map((i) => `${i.sku}: fq=${i.fulfillableQuantity}/q=${i.quantity}`)
          .join(', ')})`,
      });
      continue;
    }
    if (o.items.every((i) => i.quantity <= 0)) {
      needReview.push({ order: o, reason: 'mọi dòng đều quantity<=0' });
      continue;
    }
    toApply.push(o);
  }

  console.log(`\nSẽ tự động reserve: ${toApply.length} đơn`);
  console.log(`Cần review tay (KHÔNG tự ghi): ${needReview.length} đơn`);
  needReview.forEach((r) => console.log(`  - ${r.order.name} (sapo_id=${r.order.sapoId}): ${r.reason}`));

  if (!APPLY) {
    console.log('\n(chạy lại với --apply để ghi committed cho phần "sẽ tự động reserve")');
    await app.close();
    await prisma.$disconnect();
    return;
  }

  // BƯỚC 4: ghi thật — 1 transaction / đơn (atomic theo đơn, không atomic
  // toàn batch — nếu mất kết nối giữa chừng, các đơn đã commit vẫn giữ
  // nguyên, chạy lại script sẽ tự bỏ qua nhờ idempotency-check).
  let done = 0;
  let failed = 0;
  for (const o of toApply) {
    try {
      await prisma.$transaction(async (tx) => {
        for (const item of sortForLocking(
          o.items.filter((i) => i.quantity > 0).map((i) => ({ ...i, locationId: o.locationId })),
        )) {
          await inventory.applyMovement(
            {
              variantId: item.variantId,
              locationId: o.locationId,
              bucket: InventoryBucket.committed,
              change: item.quantity,
              type: MovementType.order_reserve,
              referenceType: 'order',
              referenceId: o.id,
            },
            tx,
          );
        }
      }, MOVEMENT_TX_OPTIONS);
      done += 1;
      if (done % 100 === 0) console.log(`  ...${done}/${toApply.length}`);
    } catch (e: any) {
      failed += 1;
      console.error(`  ⚠ ${o.name} (id=${o.id}): ${e.message.split('\n')[0]}`);
    }
  }

  console.log(`\n=== KẾT QUẢ ===`);
  console.log(`đã reserve: ${done} đơn | lỗi: ${failed} đơn | cần review tay: ${needReview.length} đơn`);

  await app.close();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
