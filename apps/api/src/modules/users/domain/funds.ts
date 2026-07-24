/** 资金冻结关联的业务对象；订单与履约保证金必须通过此原语，而不是直接改账户字段。 */
export interface FundHoldTarget {
  entityType: string;
  entityId: string;
  reason: string;
}

export function assertPositiveMinorUnits(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError("金额必须是正的安全整数最小单位");
  }
}
