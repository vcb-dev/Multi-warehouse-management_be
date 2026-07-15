import { Injectable } from '@nestjs/common';

export type OptionInput = { name: string; values: string[] };

export type VariantInput = {
  option_values: string[];
  sku: string;
  price: number;
  cost?: number;
  compare_at_price?: number;
  barcode?: string;
  image_url?: string;
  weight?: number;
  weight_unit?: string;
};

/** Tích Descartes các giá trị thuộc tính → tổ hợp phiên bản (P-2) */
@Injectable()
export class VariantService {
  cartesian(options: OptionInput[]): string[][] {
    if (!options.length) return [[]];
    const [first, ...rest] = options;
    const restCombos = this.cartesian(rest);
    const result: string[][] = [];
    for (const value of first.values) {
      for (const combo of restCombos) {
        result.push([value, ...combo]);
      }
    }
    return result;
  }

  /** Chuẩn hoá 1 phần SKU: lowercase, giữ tiếng Việt, nối bằng dấu gạch */
  slugPart(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
  }

  /** Sinh SKU từ slug SP + giá trị thuộc tính theo thứ tự option */
  suggestSku(productSlug: string, optionValues: string[]): string {
    const base = this.slugPart(productSlug || 'san-pham');
    if (!optionValues.length) return base;
    const suffix = optionValues.map((v) => this.slugPart(v)).join('-');
    return `${base}-${suffix}`;
  }

  optionKey(values: string[]): string {
    return values.join('\0');
  }
}
