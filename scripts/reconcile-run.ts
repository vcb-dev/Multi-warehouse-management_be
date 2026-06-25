#!/usr/bin/env ts-node
/**
 * Chạy đối soát sổ cái một lần (CLI).
 * Usage: npm run reconcile
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ReconcileService } from '../src/modules/inventory/reconcile.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const reconcile = app.get(ReconcileService);
  const report = await reconcile.runFullReconcile();
  console.log(JSON.stringify(report, null, 2));
  await app.close();
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
