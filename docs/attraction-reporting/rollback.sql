-- Rolls back "Attraction visitor reporting" (db/schema.sql, block at the end).
-- WHAT IT DOES: drops the seven attraction_* tables, their functions and the
-- four guard triggers on monthly_reports, monthly_report_counts,
-- register_entries and register_entry_guests. Earlier attraction reports, the
-- Guest Register, the 2025 municipal totals, accounts, listings and the
-- accommodation tables are not touched.
-- IT DELETES WHAT SUPPORT STAFF RECORDED SINCE THE ROLLOUT (daily counts,
-- versions, history, issued outputs). Export those tables first (CSV from the
-- Supabase SQL Editor) and run this only with the user's yes.
-- Run the code rollback (revert the commit on main, redeploy) FIRST, then this,
-- so no running code points at tables that are gone.
begin;
drop trigger if exists monthly_reports_attraction_legacy on public.monthly_reports;
drop trigger if exists monthly_report_counts_attraction_legacy on public.monthly_report_counts;
drop trigger if exists register_entries_attraction_legacy on public.register_entries;
drop trigger if exists register_entry_guests_attraction_legacy on public.register_entry_guests;
drop table if exists public.attraction_outputs;
drop table if exists public.attraction_period_events;
drop table if exists public.attraction_periods;
drop table if exists public.attraction_report_versions;
drop table if exists public.attraction_count_changes;
drop table if exists public.attraction_daily_counts;
drop table if exists public.attraction_settings;
drop function if exists public.attraction_legacy_guard();
drop function if exists public.attraction_output_guard();
drop function if exists public.attraction_period_guard();
drop function if exists public.attraction_version_reconcile();
drop function if exists public.attraction_version_guard();
drop function if exists public.attraction_month_missing(text, integer, integer);
drop function if exists public.attraction_counts_guard();
drop function if exists public.attraction_immutable();
drop function if exists public.attraction_assert_place(text);
commit;
