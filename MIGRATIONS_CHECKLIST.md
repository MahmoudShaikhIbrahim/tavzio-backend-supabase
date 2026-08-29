# Migration sync checklist — staging vs production
Every migration in `supabase/migrations/` needs to be run **manually** in the
Supabase SQL editor for each project — staging and production are separate
databases, so running a migration on one never touches the other.

**The rule: staging always gets a new migration first. It only ever gets run
on production once it's been confirmed working on staging.**

Since this repo was built directly against production for a while before
staging existed, every migration below is very likely already applied to
production. Check off `Staging` for these based on what you actually ran
when you set up the staging Supabase project (see `STAGING.md`) — if you ran
every file in this folder in order at that time, check every box in both
columns and this file is simply up to date from day one.

From here on, every NEW migration file gets a new row at the bottom of this
table, added in the same commit/PR that adds the migration file itself.

| # | Migration file | Staging | Production |
|---|---|---|---|
| 0001 | `0001_init.sql` | [ ] | [ ] |
| 0002 | `0002_loyalty.sql` | [ ] | [ ] |
| 0003 | `0003_realtime_and_device_trust.sql` | [ ] | [ ] |
| 0004 | `0004_storage_and_analytics.sql` | [ ] | [ ] |
| 0005 | `0005_remove_country_analytics.sql` | [ ] | [ ] |
| 0006 | `0006_ordering_and_pos.sql` | [ ] | [ ] |
| 0007 | `0007_features_and_booking.sql` | [ ] | [ ] |
| 0008 | `0008_access_methods.sql` | [ ] | [ ] |
| 0009 | `0009_paybill_customization_and_selfservice.sql` | [ ] | [ ] |
| 0010 | `0010_ops_money_and_support.sql` | [ ] | [ ] |
| 0011 | `0011_loyalty_redesign_and_rls_fix.sql` | [ ] | [ ] |
| 0012 | `0012_analytics_fixes.sql` | [ ] | [ ] |
| 0013 | `0013_loyalty_membership_update_rls_fix.sql` | [ ] | [ ] |
| 0014 | `0014_link_icon_defaults.sql` | [ ] | [ ] |
| 0015 | `0015_custom_button_images.sql` | [ ] | [ ] |
| 0016 | `0016_link_label_and_image.sql` | [ ] | [ ] |
| 0017 | `0017_account_theme_preference.sql` | [ ] | [ ] |
| 0018 | `0018_content_translations.sql` | [ ] | [ ] |
| 0019 | `0019_ordering_pause_toggles.sql` | [ ] | [ ] |
| 0020 | `0020_multi_provider_payments.sql` | [ ] | [ ] |
| 0021 | `0021_receipts.sql` | [ ] | [ ] |
| 0022 | `0022_ziina_receipt_payments.sql` | [ ] | [ ] |
| 0023 | `0023_realtime_split_bill.sql` | [ ] | [ ] |
| 0024 | `0024_fix_payment_provider_constraint.sql` | [ ] | [ ] |
| 0025 | `0025_order_status_and_manual_payments.sql` | [ ] | [ ] |
| 0026 | `0026_special_offers_and_notifications.sql` | [ ] | [ ] |
| 0027 | `0027_kitchen_ready_notifications.sql` | [ ] | [ ] |
| 0028 | `0028_paid_at_expiry.sql` | [ ] | [ ] |
| 0029 | `0029_pay_before_order_and_appearance.sql` | [ ] | [ ] |
| 0030 | `0030_contracts_and_inventory.sql` | [ ] | [ ] |
| 0031 | `0031_stripe_billing_and_public_signing.sql` | [ ] | [ ] |
| 0032 | `0032_password_reset_and_leads.sql` | [ ] | [ ] |
| 0033 | `0033_pos_terminal_and_till.sql` | [ ] | [ ] |
| 0034 | `0034_table_management.sql` | [ ] | [ ] |
| 0035 | `0035_delivery_integration.sql` | [ ] | [ ] |
| 0036 | `0036_rbac_foundation.sql` | [ ] | [ ] |
| 0037 | `0037_pms_core.sql` | [ ] | [ ] |
| 0038 | `0038_hotel_financial_advanced.sql` | [ ] | [ ] |
| 0039 | `0039_guest_portal_housekeeping_maintenance.sql` | [ ] | [ ] |
| 0040 | `0040_external_hotel_systems.sql` | [ ] | [ ] |
| 0041 | `0041_hotel_payment_processing.sql` | [ ] | [ ] |
| 0042 | `0042_password_reset_audit_action.sql` | [ ] | [ ] |
| 0043 | `0043_fix_empty_external_integrations.sql` | [ ] | [ ] |
| 0044 | `0044_staff_assigned_sections.sql` | [ ] | [ ] |
| 0045 | `0045_hotel_outlets.sql` | [ ] | [ ] |
| 0046 | `0046_widen_guest_request_types.sql` | [ ] | [ ] |
| 0047 | `0047_guest_portal_realtime.sql` | [ ] | [ ] |
| 0048 | `0048_discounts_shifts_courses_groups.sql` | [ ] | [ ] |
| 0049 | `0049_hr_module.sql` | [ ] | [ ] |
| 0050 | `0050_fix_order_source_constraint.sql` | [ ] | [ ] |
| 0051 | `0051_organizations.sql` | [ ] | [ ] |
| 0052 | `0052_fix_audit_log_action_constraint.sql` | [ ] | [ ] |
| 0053 | `0053_zoho_books_integration.sql` | [ ] | [ ] |
| 0054 | `0054_till_outlet_locking.sql` | [ ] | [ ] |
| 0055 | `0055_bill_payment_race_fix.sql` | [ ] | [ ] |
| 0056 | `0056_unified_notification_buttons.sql` | [ ] | [ ] |
| 0057 | `0057_button_routing_and_groups.sql` | [ ] | [ ] |
| 0058 | `0058_owner_manages_own_ordering_integration.sql` | [ ] | [ ] |
| 0059 | `0059_folio_charge_delete_action.sql` | [ ] | [ ] |
| 0060 | `0060_staff_preferred_language.sql` | [ ] | [ ] |
| 0061 | `0061_advanced_inventory.sql` | [ ] | [ ] |
| 0062 | `0062_labor_scheduling.sql` | [ ] | [ ] |
| 0063 | `0063_forecasting_budgeting.sql` | [ ] | [ ] |
| 0064 | `0064_advanced_kds.sql` | [ ] | [ ] |
| 0065 | `0065_hotel_revenue_management.sql` | [ ] | [ ] |
| 0066 | `0066_advanced_housekeeping.sql` | [ ] | [ ] |
| 0067 | `0067_advanced_maintenance.sql` | [ ] | [ ] |
| 0068 | `0068_guest_management.sql` | [ ] | [ ] |
| 0069 | `0069_city_ledger.sql` | [ ] | [ ] |
| 0070 | `0070_advanced_night_audit.sql` | [ ] | [ ] |
| 0071 | `0071_sales_events.sql` | [ ] | [ ] |
| 0072 | `0072_customizable_guest_services.sql` | [ ] | [ ] |
| 0073 | `0073_advanced_booking.sql` | [ ] | [ ] |
| 0074 | `0074_standalone_contracts.sql` | [ ] | [ ] |
| 0075 | `0075_digital_business_card.sql` | [ ] | [ ] |
| 0076 | `0076_payroll.sql` | [ ] | [ ] |
| 0077 | `0077_native_accounting.sql` | [ ] | [ ] |
| 0078 | `0078_channel_manager.sql` | [ ] | [ ] |
| 0079 | `0079_marketing_automation.sql` | [ ] | [ ] |
| 0080 | `0080_wps_payroll_fields.sql` | [ ] | [ ] |
| 0081 | `0081_cyber_insurance_fields.sql` | [ ] | [ ] |
| 0082 | `0082_nullable_room_id_guest_requests.sql` | [ ] | [ ] |
| 0083 | `0083_staff_full_access_and_nav_layout.sql` | [ ] | [ ] |
| 0084 | `0084_tour_completed.sql` | [ ] | [ ] |
| 0085 | `0085_demo_system.sql` | [ ] | [ ] |
| 0086 | `0086_contract_termination.sql` | [ ] | [ ] |
| 0087 | `0087_pricing_inquiry_leads.sql` | [ ] | [ ] |
| 0088 | `0088_lead_business_name_pos.sql` | [ ] | [ ] |
| 0089 | `0089_warehouses_and_transfers.sql` | [ ] | [ ] |
| 0090 | `0090_org_supply_chain.sql` | [ ] | [ ] |
| 0091 | `0091_org_po_item_correction.sql` | [ ] | [ ] |
| 0092 | `0092_online_booking_advanced.sql` | [ ] | [ ] |
| 0093 | `0093_verify_now_otp.sql` | [ ] | [ ] |
| 0094 | `0094_staff_visibility_and_delete.sql` | [ ] | [ ] |
| 0095 | `0095_staff_realtime.sql` | [ ] | [ ] |
| 0096 | `0096_org_self_service.sql` | [ ] | [ ] |
| 0097 | `0097_staff_mutation_fixes.sql` | [ ] | [ ] |
| 0098 | `0098_org_owner_dual_capability.sql` | [ ] | [ ] |
| 0099 | `0099_order_type.sql` | [ ] | [ ] |
| 0100 | `0100_pos_pin_access.sql` | [ ] | [ ] |
| 0101 | `0101_payment_till_tracking.sql` | [ ] | [ ] |
| 0102 | `0102_kitchen_station_printers.sql` | [ ] | [ ] |
| 0103 | `0103_fix_purchase_orders_rls_recursion.sql` | [ ] | [ ] |
| 0104 | `0104_contract_billing_notifications.sql` | [ ] | [ ] |
| 0105 | `0105_fix_purchase_order_items_rls_recursion.sql` | [ ] | [ ] |
| 0106 | `0106_fix_purchase_order_allocations_rls_recursion.sql` | [ ] | [ ] |
| 0107 | `0107_real_table_entity.sql` | [ ] | [ ] |
| 0108 | `0108_fix_bookings_table_id_reference.sql` | [ ] | [ ] |
| 0109 | `0109_diagnose_and_fix_bookings_table_id.sql` | [ ] | [ ] |
| 0110 | `0110_fix_bookings_table_id_ordering.sql` | [ ] | [ ] |
| 0111 | `0111_service_options_and_booking.sql` | [ ] | [ ] |
| 0112 | `0112_purchase_order_receive_log.sql` | [ ] | [ ] |
| 0113 | `0113_demo_settings_and_requests.sql` | [ ] | [ ] |
| 0114 | `0114_guest_request_target_section.sql` | [ ] | [ ] |
| 0115 | `0115_backfill_stale_order_totals.sql` | [ ] | [ ] |
| 0116 | `0116_custom_button_note_and_color.sql` | [ ] | [ ] |
| 0117 | `0117_booking_items_note.sql` | [ ] | [ ] |
| 0118 | `0118_operating_and_booking_hours.sql` | [ ] | [ ] |
| 0119 | `0119_order_completed_at_and_cleanup.sql` | [ ] | [ ] |
| 0120 | `0120_fix_order_items_realtime_rls.sql` | [ ] | [ ] |
| 0121 | `0121_drive_through_orders.sql` | [ ] | [ ] |
| 0122 | `0122_floor_plan.sql` | [ ] | [ ] |

## How to apply a migration

1. Open the target Supabase project (staging or production) → SQL Editor.
2. Open the migration file locally, copy its full contents.
3. Paste into the SQL editor, run it.
4. Check the matching box in the table above and commit that change —
   this file is only useful if it's kept honest.

## If staging and production ever drift

If a box is checked for Production but not Staging (or vice versa), that
environment's schema is out of sync — find the file, run it there, check
the box. Don't guess from memory; if in doubt, compare actual table/column
state in both projects' Table Editor rather than trust this file blindly
after a long gap.
