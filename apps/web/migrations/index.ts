import * as migration_20260803_095130_d0_initial from './20260803_095130_d0_initial'
import * as migration_20260804_082759_add_payment_notification_merchant_order_unique from './20260804_082759_add_payment_notification_merchant_order_unique'
import * as migration_20260804_234636_d1_seo_foundation from './20260804_234636_d1_seo_foundation'
import * as migration_20260805_005736_d1_redirect_foundation from './20260805_005736_d1_redirect_foundation'
import * as migration_20260805_040152 from './20260805_040152'
import * as migration_20260805_080646_d1_audit_navigation from './20260805_080646_d1_audit_navigation'
import * as migration_20260805_090521_d1_first_party_events from './20260805_090521_d1_first_party_events'
import * as migration_20260806_055310_d2_tld_price_snapshots from './20260806_055310_d2_tld_price_snapshots'
import * as migration_20260806_113033_d2_tool_observability from './20260806_113033_d2_tool_observability'
import * as migration_20260806_141657_d3_content_cms_workflow from './20260806_141657_d3_content_cms_workflow'

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
  {
    up: migration_20260805_080646_d1_audit_navigation.up,
    down: migration_20260805_080646_d1_audit_navigation.down,
    name: '20260805_080646_d1_audit_navigation',
  },
  {
    up: migration_20260805_090521_d1_first_party_events.up,
    down: migration_20260805_090521_d1_first_party_events.down,
    name: '20260805_090521_d1_first_party_events',
  },
  {
    up: migration_20260806_055310_d2_tld_price_snapshots.up,
    down: migration_20260806_055310_d2_tld_price_snapshots.down,
    name: '20260806_055310_d2_tld_price_snapshots',
  },
  {
    up: migration_20260806_113033_d2_tool_observability.up,
    down: migration_20260806_113033_d2_tool_observability.down,
    name: '20260806_113033_d2_tool_observability',
  },
  {
    up: migration_20260806_141657_d3_content_cms_workflow.up,
    down: migration_20260806_141657_d3_content_cms_workflow.down,
    name: '20260806_141657_d3_content_cms_workflow',
  },
]
