-- Rollback of "Accommodation reporting (stage 2)" in db/schema.sql.
-- Run only with the user's yes, after exporting the accommodation_* tables
-- (they hold whatever managers recorded since the rollout; this drops them).
-- Touches nothing else: monthly_reports, monthly_report_counts, report_changes,
-- residences, spots, room_types and bookings keep every row.
begin;
drop trigger if exists monthly_reports_accommodation_guard on public.monthly_reports;
drop table if exists public.accommodation_changes, public.accommodation_period_events, public.accommodation_periods,
    public.accommodation_report_version_counts, public.accommodation_report_versions,
    public.accommodation_stay_guests, public.accommodation_stay_rooms, public.accommodation_stays,
    public.accommodation_closed_periods, public.accommodation_room_unavailability, public.accommodation_rooms,
    public.accommodation_profiles cascade;
drop function if exists public.accommodation_assert_open(text, date, date), public.accommodation_assert_place(text),
    public.accommodation_guard_rows(), public.accommodation_check_stay(), public.accommodation_stay_status_follow(),
    public.accommodation_immutable(), public.accommodation_version_guard(), public.accommodation_version_reconcile(),
    public.accommodation_municipal_guard(), public.accommodation_period_guard();
-- btree_gist stays installed: harmless, and other schemas may come to use it.
commit;
