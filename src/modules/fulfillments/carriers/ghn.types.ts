export type GhnCredentials = {
  token: string;
  shopId: number;
};

export type GhnCreateOrderInput = {
  clientOrderCode: string;
  fromName: string;
  fromPhone: string;
  fromAddress: string;
  fromWardName?: string;
  fromDistrictName?: string;
  fromProvinceName?: string;
  toName: string;
  toPhone: string;
  toAddress: string;
  toWardName?: string;
  toDistrictName?: string;
  toProvinceName?: string;
  codAmount: number;
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  /** 1 = shop trả, 2 = khách trả */
  paymentTypeId: 1 | 2;
  requiredNote: 'CHOTHUHANG' | 'CHOXEMHANGKHONGTHU' | 'KHONGCHOXEMHANG';
  note?: string;
  content?: string;
  insuranceValue?: number;
  /** 2 = hàng nhẹ (mặc định), 5 = hàng nặng */
  serviceTypeId?: 2 | 5;
};

export type GhnCreateOrderResult = {
  orderCode: string;
  totalFee: number;
  expectedDeliveryTime: string | null;
  sortCode: string | null;
};

export type GhnApiResponse<T> = {
  code: number;
  message: string;
  data: T;
  code_message?: string;
  message_display?: string;
};

export type GhnCreateOrderData = {
  order_code: string;
  sort_code?: string;
  total_fee?: number | string;
  expected_delivery_time?: string;
  fee?: { main_service?: number };
};

export type GhnConnectionConfig = {
  token?: string | null;
  shop_id?: string | number | null;
};
