import * as migration_20260803_095130_d0_initial from './20260803_095130_d0_initial';
import * as migration_20260804_082759_add_payment_notification_merchant_order_unique from './20260804_082759_add_payment_notification_merchant_order_unique';

export const migrations = [
  {
    up: migration_20260803_095130_d0_initial.up,
    down: migration_20260803_095130_d0_initial.down,
    name: '20260803_095130_d0_initial',
  },
  {
    up: migration_20260804_082759_add_payment_notification_merchant_order_unique.up,
    down: migration_20260804_082759_add_payment_notification_merchant_order_unique.down,
    name: '20260804_082759_add_payment_notification_merchant_order_unique'
  },
];
