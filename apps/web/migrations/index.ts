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
import * as migration_20260807_004430_d3_content_relations_seo from './20260807_004430_d3_content_relations_seo'
import * as migration_20260807_025608_d3_advertising_controlled_delivery from './20260807_025608_d3_advertising_controlled_delivery'
import * as migration_20260807_042030_d3_ad_events_maintenance from './20260807_042030_d3_ad_events_maintenance'
import * as migration_20260807_061433_d3_form_builder_entries from './20260807_061433_d3_form_builder_entries'
import * as migration_20260807_095514_d4_customer_auth_sms from './20260807_095514_d4_customer_auth_sms'
import * as migration_20260807_114644_d4_realname_templates from './20260807_114644_d4_realname_templates'
import * as migration_20260807_125811_d4_private_realname_documents from './20260807_125811_d4_private_realname_documents'
import * as migration_20260807_135646_d4_realname_lifecycle from './20260807_135646_d4_realname_lifecycle'
import * as migration_20260807_140407_d4_realname_cleanup_completion from './20260807_140407_d4_realname_cleanup_completion'
import * as migration_20260807_145526_d5_customer_quotes from './20260807_145526_d5_customer_quotes'
import * as migration_20260808_015442_d5_wechat_payments from './20260808_015442_d5_wechat_payments'
import * as migration_20260808_031431_d5_wechat_refunds_reconciliation from './20260808_031431_d5_wechat_refunds_reconciliation'
import * as migration_20260808_053208_d5_price_rules from './20260808_053208_d5_price_rules'

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
  {
    up: migration_20260807_004430_d3_content_relations_seo.up,
    down: migration_20260807_004430_d3_content_relations_seo.down,
    name: '20260807_004430_d3_content_relations_seo',
  },
  {
    up: migration_20260807_025608_d3_advertising_controlled_delivery.up,
    down: migration_20260807_025608_d3_advertising_controlled_delivery.down,
    name: '20260807_025608_d3_advertising_controlled_delivery',
  },
  {
    up: migration_20260807_042030_d3_ad_events_maintenance.up,
    down: migration_20260807_042030_d3_ad_events_maintenance.down,
    name: '20260807_042030_d3_ad_events_maintenance',
  },
  {
    up: migration_20260807_061433_d3_form_builder_entries.up,
    down: migration_20260807_061433_d3_form_builder_entries.down,
    name: '20260807_061433_d3_form_builder_entries',
  },
  {
    up: migration_20260807_095514_d4_customer_auth_sms.up,
    down: migration_20260807_095514_d4_customer_auth_sms.down,
    name: '20260807_095514_d4_customer_auth_sms',
  },
  {
    up: migration_20260807_114644_d4_realname_templates.up,
    down: migration_20260807_114644_d4_realname_templates.down,
    name: '20260807_114644_d4_realname_templates',
  },
  {
    up: migration_20260807_125811_d4_private_realname_documents.up,
    down: migration_20260807_125811_d4_private_realname_documents.down,
    name: '20260807_125811_d4_private_realname_documents',
  },
  {
    up: migration_20260807_135646_d4_realname_lifecycle.up,
    down: migration_20260807_135646_d4_realname_lifecycle.down,
    name: '20260807_135646_d4_realname_lifecycle',
  },
  {
    up: migration_20260807_140407_d4_realname_cleanup_completion.up,
    down: migration_20260807_140407_d4_realname_cleanup_completion.down,
    name: '20260807_140407_d4_realname_cleanup_completion',
  },
  {
    up: migration_20260807_145526_d5_customer_quotes.up,
    down: migration_20260807_145526_d5_customer_quotes.down,
    name: '20260807_145526_d5_customer_quotes',
  },
  {
    up: migration_20260808_015442_d5_wechat_payments.up,
    down: migration_20260808_015442_d5_wechat_payments.down,
    name: '20260808_015442_d5_wechat_payments',
  },
  {
    up: migration_20260808_031431_d5_wechat_refunds_reconciliation.up,
    down: migration_20260808_031431_d5_wechat_refunds_reconciliation.down,
    name: '20260808_031431_d5_wechat_refunds_reconciliation',
  },
  {
    up: migration_20260808_053208_d5_price_rules.up,
    down: migration_20260808_053208_d5_price_rules.down,
    name: '20260808_053208_d5_price_rules',
  },
]
