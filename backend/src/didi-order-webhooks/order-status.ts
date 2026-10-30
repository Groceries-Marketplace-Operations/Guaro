// Keep names and values aligned with grocery_tools/operations/models.OrderStatus.
export enum OrderStatus {
  CREATED = 100,
  ASSIGNED = 120,
  ARRIVED_AT_B = 130,
  TAKEN = 140,
  ARRIVED_AT_C = 150,
  FINISH = 160,
  CANCEL = 170,
  REASSIGNED = 180,
  ABORTED = 190,
  STORE_ACCEPTED = 200,
  TOOK_FOR_DELIVERY = 400,
  ARRIVED_AT_C_2 = 500,
  FINISHED = 600,
  CANCELLED_BY_THE_CUSTOMER = 901,
  CANCELLED_BY_THE_CUSTOMER_2 = 902,
  CANCELLED_BY_THE_STORE = 921,
  CANCELLED_BY_THE_STORE_2 = 923,
  CANCELLED_BY_THE_STORE_TIMEOUT = 922,
  CANCELLED_BY_CX = 961,
  CANCELLED_BY_CURRIER = 971,
  CANCELLED_BY_CURRIER_2 = 981,
}

export const BAD_CANCELLATIONS = new Set<number>([
  OrderStatus.CANCELLED_BY_CX,
  OrderStatus.CANCELLED_BY_THE_CUSTOMER_2,
  OrderStatus.CANCELLED_BY_THE_STORE,
  OrderStatus.CANCELLED_BY_THE_STORE_2,
  OrderStatus.CANCELLED_BY_THE_STORE_TIMEOUT,
  OrderStatus.CANCELLED_BY_CURRIER,
  OrderStatus.CANCELLED_BY_CURRIER_2,
]);
export const CANCELLATION_STATUSES = new Set<number>([OrderStatus.CANCELLED_BY_THE_CUSTOMER, ...BAD_CANCELLATIONS]);
export const FINISHED_STATUSES = new Set<number>([OrderStatus.FINISH, OrderStatus.FINISHED]);
export const ORDER_STATUSES = new Set(Object.values(OrderStatus).filter((status): status is number => typeof status === 'number'));
