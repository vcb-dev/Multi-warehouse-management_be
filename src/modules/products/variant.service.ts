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

  /** Sinh SKU gợi ý từ slug + option values */
  suggestSku(productSlug: string, optionValues: string[]): string {
    const suffix = optionValues
      .map((v) =>
        v
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-zA-Z0-9]+/g, '-')
          .toUpperCase()
          .slice(0, 12),
      )
      .join('-');
    const base = productSlug.toUpperCase().replace(/[^A-Z0-9]+/g, '-');
    return suffix ? `${base}-${suffix}` : base;
  }

  optionKey(values: string[]): string {
    return values.join('\0');
  }
}
