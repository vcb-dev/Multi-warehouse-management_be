import { Injectable, Logger } from '@nestjs/common';

export interface SapoVariant {
  id: number;
  product_id: number;
  inventory_item_id: number | null;
  sku: string | null;
  barcode: string | null;
  title: string | null;
  price: number;
  compare_at_price: number | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  taxable: boolean;
  inventory_management: string | null;
  inventory_policy: string | null;
  lot_management: boolean;
  requires_shipping: boolean;
  requires_components: boolean;
  weight: number | null;
  weight_unit: string | null;
  unit: string | null;
  image_id: number | null;
  position: number;
  type: string | null;
}

export interface SapoImage {
  id: number;
  product_id: number;
  position: number;
  src: string;
}

export interface SapoOption {
  id: number;
  name: string;
  position: number;
  values: string[];
}

export interface SapoProduct {
  id: number;
  name: string;
  alias: string | null;
  vendor: string | null;
  product_type: string | null;
  meta_title: string | null;
  meta_description: string | null;
  summary: string | null;
  published_on: string | null;
  template_layout: string | null;
  created_on: string;
  modified_on: string;
  content: string | null;
  tags: string | null;
  status: string;
  type: string | null;
  vat_pit_category_code: string | null;
  images: SapoImage[];
  image: SapoImage | null;
  variants: SapoVariant[];
  options: SapoOption[];
}

/**
 * Client gọi thẳng Admin API của Sapo. Trước dự án này chưa từng gọi API Sapo
 * từ backend — mọi việc đồng bộ sản phẩm đều làm bằng script chạy tay
 * (xem `backend/scripts/*.js`). Đây là lần đầu đưa việc đó vào NestJS.
 */
@Injectable()
export class SapoClient {
  private readonly logger = new Logger(SapoClient.name);
  private readonly store = process.env.SAPO_STORE;
  private readonly auth = Buffer.from(
    `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
  ).toString('base64');

  isConfigured(): boolean {
    return Boolean(
      process.env.SAPO_STORE &&
        process.env.SAPO_API_KEY &&
        process.env.SAPO_API_SECRET,
    );
  }

  /**
   * GET bất kỳ đường dẫn Admin API nào, dùng chung phần auth + retry ở đây.
   *
   * Mở ra public để đường đồng bộ đơn (`channels/sapo`) không phải dựng lại client thứ hai
   * với cùng Basic auth và cùng cách lùi thời gian khi gặp 429 — trước đó mỗi script tự
   * viết một bản `api()` riêng (xem `scripts/sync-new-sapo-orders.ts`).
   */
  get<T>(path: string, tries = 5): Promise<T> {
    return this.request<T>(path, tries);
  }

  /**
   * Header `x-sapo-api-call-limit` ("đã dùng/tổng") của lượt gọi gần nhất, hoặc null nếu
   * Sapo không trả. Dùng để tự giãn nhịp TRƯỚC khi chạm trần thay vì chờ ăn 429 rồi mới lùi —
   * quan trọng với các lượt quét cả catalog (đồng bộ tồn kho), không cần cho vài lời gọi lẻ.
   */
  get lastRateLimit(): string | null {
    return this.rateLimit;
  }

  private rateLimit: string | null = null;

  private async request<T>(path: string, tries = 5): Promise<T> {
    let lastErr: unknown;
    for (let i = 1; i <= tries; i++) {
      try {
        const res = await fetch(`https://${this.store}.mysapo.net${path}`, {
          headers: { Authorization: `Basic ${this.auth}` },
        });
        this.rateLimit = res.headers.get('x-sapo-api-call-limit');
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 2000 * i));
          continue;
        }
        if (!res.ok) throw new Error(`Sapo HTTP ${res.status} — ${path}`);
        return (await res.json()) as T;
      } catch (e) {
        lastErr = e;
        if (i === tries) break;
        await new Promise((r) => setTimeout(r, 800 * i));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * Trang qua toàn bộ sản phẩm đã đổi kể từ `updatedAtMin` (ISO string).
   * Không truyền `updatedAtMin` để quét toàn bộ catalog (dùng cho lượt vá đầu
   * tiên hoặc soát định kỳ, không phải nhịp chạy thường xuyên).
   */
  async *iterateProducts(
    updatedAtMin?: string,
    pageSize = 250,
  ): AsyncGenerator<SapoProduct> {
    for (let page = 1; ; page++) {
      const qs = new URLSearchParams({
        page: String(page),
        limit: String(pageSize),
      });
      if (updatedAtMin) qs.set('updated_at_min', updatedAtMin);
      const j = await this.request<{ products: SapoProduct[] }>(
        `/admin/products.json?${qs.toString()}`,
      );
      const products = j.products ?? [];
      for (const p of products) yield p;
      if (products.length < pageSize) break;
    }
  }
}
