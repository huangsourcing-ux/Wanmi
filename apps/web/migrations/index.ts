import * as migration_20260803_095130_d0_initial from './20260803_095130_d0_initial'
import * as migration_20260804_082759_add_payment_notification_merchant_order_unique from './20260804_082759_add_payment_notification_merchant_order_unique'
import * as migration_20260804_234636_d1_seo_foundation from './20260804_234636_d1_seo_foundation'
import * as migration_20260805_005736_d1_redirect_foundation from './20260805_005736_d1_redirect_foundation'
import * as migration_20260805_040152 from './20260805_040152'

export const migrations = [
  {
    up: migration_20260803_095130_d0_initial.up,
    down: migration_20260803_095130_d0_initial.down,
    name: '20260803_095130_d0_initial',
  },
  {
    up: migration_20260804_082759_add_payment_notification_merchant_order_unique.up,
    down: migration_20260804_082759_add_payment_notification_merchant_order_unique.down,
    name: '20260804_082759_add_payment_notification_merchant_order_unique',
  },
  {
    up: migration_20260804_234636_d1_seo_foundation.up,
    down: migration_20260804_234636_d1_seo_foundation.down,
    name: '20260804_234636_d1_seo_foundation',
  },
  {
    up: migration_20260805_005736_d1_redirect_foundation.up,
    down: migration_20260805_005736_d1_redirect_foundation.down,
    name: '20260805_005736_d1_redirect_foundation',
  },
  {
    up: migration_20260805_040152.up,
    down: migration_20260805_040152.down,
    name: '20260805_040152',
  },
]
