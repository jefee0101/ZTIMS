-- ZTIMS database schema, for Supabase (PostgreSQL 15 or later).
--
-- Safe to run more than once: every statement creates only what is missing,
-- so this file is both the first-time setup and the way to bring an existing
-- database up to date. `npm run migrate` runs it; so does pasting it into the
-- Supabase SQL Editor.
--
-- Who can read these tables
-- -------------------------
-- Only the ZTIMS API. It connects as the database owner and enforces every
-- permission itself, in server.js, exactly as it did on MongoDB.
--
-- Supabase also publishes every table through its own REST API to anyone
-- holding the project's public ("anon") key. Row Level Security is switched on
-- for every table below and NO policies are defined, which means that route
-- returns nothing for any table, whoever asks. Do not add policies unless the
-- browser is deliberately meant to read a table directly — nothing in ZTIMS
-- does.
--
-- Ids
-- ---
-- Text, 24 hex characters, the same shape MongoDB's ObjectIds had. The records
-- copied from MongoDB keep their original ids, so links already shared
-- (spot.html?spotId=…) and signed-in sessions (the token carries the account
-- id) keep working across the move. New rows get a random id in the same
-- shape.

create or replace function public.ztims_new_id()
returns text
language sql
volatile
set search_path = ''
as $$
    select left(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 24)
$$;

-- Every table has updated_at; this keeps it honest on every UPDATE, however
-- the row was changed — from the API, a script, or the Supabase table editor.
create or replace function public.ztims_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = pg_catalog.now();
    return new;
end
$$;


-- ---------------------------------------------------------------------------
-- Tourism Officers: the municipal accounts that oversee everything.
-- Copied from MongoDB's `admins` collection.
-- ---------------------------------------------------------------------------
create table if not exists public.tourism_officers (
    id                  text primary key default public.ztims_new_id(),
    email               text not null unique
                        constraint tourism_officers_email_normalised
                        check (email <> '' and email = lower(btrim(email))),
    password_hash       text not null,
    -- Password reset: only the token's SHA-256 is ever stored.
    reset_token_hash    text,
    reset_token_expires timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- Tourist Establishment Managers: the accounts that keep their own listings
-- up to date. Copied from MongoDB's `resortOwners` collection.
-- ---------------------------------------------------------------------------
create table if not exists public.establishment_managers (
    id                  text primary key default public.ztims_new_id(),
    -- The sign-in address. Never shown publicly; contact_email is.
    email               text not null unique
                        constraint establishment_managers_email_normalised
                        check (email <> '' and email = lower(btrim(email))),
    password_hash       text not null,
    establishment_name  text not null
                        constraint establishment_managers_name_required
                        check (btrim(establishment_name) <> ''),
    manager_name        text not null default '',
    contact_email       text not null default '',
    phone               text not null default '',
    -- The office's switch over the account. Suspended accounts cannot sign in
    -- and their listings leave the public site; nothing is deleted.
    active              boolean not null default true,
    -- The establishment's own statement about whether it is trading.
    operational_status  text not null default 'active'
                        constraint establishment_managers_operational_status
                        check (operational_status in ('active', 'inactive', 'closed')),
    -- Raised when the establishment reports a change, cleared by the officer.
    status_needs_review boolean not null default false,
    status_note         text not null default '',
    status_updated_at   timestamptz,
    reset_token_hash    text,
    reset_token_expires timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists establishment_managers_operational_status_idx
    on public.establishment_managers (operational_status);


-- ---------------------------------------------------------------------------
-- Listings: tourist spots and accommodations.
-- ---------------------------------------------------------------------------
create table if not exists public.spots (
    id                  text primary key default public.ztims_new_id(),
    title               text not null constraint spots_title_required check (title <> ''),
    -- The short place label on cards and in search.
    location            text not null constraint spots_location_required check (location <> ''),
    category            text not null constraint spots_category_required check (category <> ''),
    description         text not null constraint spots_description_required check (description <> ''),
    -- Cover photo, and the full gallery. Only links; the files live on Cloudinary.
    image_url           text not null default '',
    images              text[] not null default '{}'
                        constraint spots_images_max check (cardinality(images) <= 30),
    -- Where "Book Now" sends a visitor: the establishment's own site.
    booking_url         text not null default '',
    type                text not null default 'spot'
                        constraint spots_type check (type in ('spot', 'accommodation')),
    label               text not null default '',
    working_days        text not null default 'Everyday',
    working_time        text not null default 'All Day',
    travel_fee          numeric not null default 0,
    entrance_fee        numeric not null default 0,
    address             text not null default '',
    barangay            text not null default '',
    municipality        text not null default 'Zamboanguita',
    province            text not null default 'Negros Oriental',
    -- Where the place is. Both or neither: half a point would put a marker in
    -- the sea. A visitor's own position is never stored anywhere.
    latitude            double precision
                        constraint spots_latitude_range check (latitude between -90 and 90),
    longitude           double precision
                        constraint spots_longitude_range check (longitude between -180 and 180),
    -- Which establishment keeps this listing accurate. Null: the Tourism Office.
    managed_by          text references public.establishment_managers (id),
    -- Listings are taken down by status, never deleted.
    status              text not null default 'published'
                        constraint spots_status check (status in ('published', 'unpublished', 'archived')),
    status_note         text not null default '',
    status_updated_at   timestamptz,
    requires_guide      boolean not null default false,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint spots_coordinates_pair check ((latitude is null) = (longitude is null))
);

create index if not exists spots_managed_by_idx on public.spots (managed_by);
create index if not exists spots_status_idx on public.spots (status);
create index if not exists spots_requires_guide_idx on public.spots (requires_guide);
create index if not exists spots_created_at_idx on public.spots (created_at desc);


-- ---------------------------------------------------------------------------
-- Tourist guides: municipal records the Tourism Office keeps. A guide may also
-- be given a sign-in (email + password below) for the guide portal, where they
-- keep their own availability and languages; everything else stays the
-- office's to set. A guide without a sign-in has email and password_hash null.
-- ---------------------------------------------------------------------------
create table if not exists public.tourist_guides (
    id                  text primary key default public.ztims_new_id(),
    full_name           text not null constraint tourist_guides_name_required check (btrim(full_name) <> ''),
    photo_url           text not null default '',
    contact_number      text not null default '',
    -- A general area, not an address: this is a person.
    location            text not null default '',
    bio                 text not null default '',
    guide_fee           numeric not null default 0
                        constraint tourist_guides_fee_not_negative check (guide_fee >= 0),
    max_group_size      integer not null default 1
                        constraint tourist_guides_group_size check (max_group_size >= 1),
    status              text not null default 'available'
                        constraint tourist_guides_status check (status in ('available', 'unavailable', 'inactive')),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists tourist_guides_status_idx on public.tourist_guides (status);

-- Added with the guide portal. Separate statements, so a database created
-- before them gains them here and one created after is left alone.
--
-- One kind of account, Tourist Guide, with a scope — the guide's jurisdiction:
--   municipal  the whole municipality; stationed at the Municipal Tourism Office
--   barangay   only the barangay named in `barangay`, where they are stationed
-- The screens are the same for both; the scope filters what a guide sees and
-- which destinations the office may assign them. `barangay` is the name, the
-- same text spots.barangay holds, so the two compare directly. The API checks
-- it against the barangay list and requires it for a barangay scope, since
-- that rule depends on another column.
alter table public.tourist_guides
    add column if not exists scope text not null default 'municipal'
        constraint tourist_guides_scope check (scope in ('municipal', 'barangay'));
alter table public.tourist_guides
    add column if not exists barangay text not null default '';
-- The weekdays the guide works. A booking on any other day is not assigned to them.
alter table public.tourist_guides
    add column if not exists available_days text[] not null default '{mon,tue,wed,thu,fri,sat,sun}'
        constraint tourist_guides_available_days
        check (available_days <@ array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']::text[]);
-- The sign-in. Null until the office issues one.
alter table public.tourist_guides
    add column if not exists email text
        constraint tourist_guides_email_normalised
        check (email is null or (email <> '' and email = lower(btrim(email))));
alter table public.tourist_guides
    add column if not exists password_hash text;
alter table public.tourist_guides
    add column if not exists reset_token_hash text;
alter table public.tourist_guides
    add column if not exists reset_token_expires timestamptz;

create unique index if not exists tourist_guides_email_key
    on public.tourist_guides (email) where email is not null;
create index if not exists tourist_guides_scope_idx on public.tourist_guides (scope, barangay);

-- Guides used to mark single days off here (guide_time_off). That was taken
-- out: a guide who cannot work now sets themselves Unavailable, or drops the
-- weekday from their working days. Dropped on the next migrate, with any days
-- off it still held.
drop table if exists public.guide_time_off;

-- Guides also used to ask here for a change to their contact number or bio,
-- for the office to approve (guide_profile_requests). Taken out too: the
-- office now edits those two fields itself, as it does the rest of the
-- record. Dropped on the next migrate, with any requests it still held.
drop table if exists public.guide_profile_requests;

-- Languages, and who speaks them. A table of their own rather than a list on
-- the guide, so "who speaks Korean" is a join, and "Korean" and "korean" are
-- one language rather than two.
create table if not exists public.languages (
    id                  text primary key default public.ztims_new_id(),
    name                text not null
                        constraint languages_name_length check (char_length(btrim(name)) between 1 and 40),
    created_at          timestamptz not null default now()
);

create unique index if not exists languages_name_key on public.languages (lower(name));

create table if not exists public.guide_languages (
    guide_id            text not null references public.tourist_guides (id) on delete cascade,
    language_id         text not null references public.languages (id) on delete cascade,
    primary key (guide_id, language_id)
);

create index if not exists guide_languages_language_idx on public.guide_languages (language_id);


-- Which spots each guide serves. MongoDB held this as an array on the guide;
-- here it is a table of its own so every entry is a real spot. `position`
-- keeps the order the office entered them in.
create table if not exists public.tourist_guide_spots (
    guide_id            text not null references public.tourist_guides (id) on delete cascade,
    spot_id             text not null references public.spots (id) on delete cascade,
    position            integer not null default 0,
    primary key (guide_id, spot_id)
);

create index if not exists tourist_guide_spots_spot_idx on public.tourist_guide_spots (spot_id);


-- ---------------------------------------------------------------------------
-- Guide bookings: requested by a visitor with no account, paid at the counter.
-- ---------------------------------------------------------------------------
create table if not exists public.guide_bookings (
    id                  text primary key default public.ztims_new_id(),
    -- TG-2026-00001: the visitor's only handle on the booking.
    reference           text not null unique,
    spot_id             text not null references public.spots (id),
    -- Null until the Tourism Office assigns a guide.
    guide_id            text references public.tourist_guides (id),
    full_name           text not null,
    contact_number      text not null,
    email               text not null,
    -- ISO 3166-1 alpha-2, or blank on bookings taken before it was asked.
    nationality         text not null default ''
                        constraint guide_bookings_nationality check (nationality = '' or nationality ~ '^[A-Z]{2}$'),
    visitors            integer not null constraint guide_bookings_visitors check (visitors >= 1),
    preferred_date      date not null,
    preferred_time      text not null
                        constraint guide_bookings_preferred_time check (preferred_time ~ '^[0-9]{2}:[0-9]{2}$'),
    notes               text not null default '',
    status              text not null default 'pending_payment'
                        constraint guide_bookings_status
                        check (status in ('pending_payment', 'confirmed', 'cancelled', 'completed', 'no_show')),
    status_note         text not null default '',
    status_updated_at   timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists guide_bookings_spot_idx on public.guide_bookings (spot_id);
create index if not exists guide_bookings_guide_date_idx on public.guide_bookings (guide_id, preferred_date);
create index if not exists guide_bookings_status_idx on public.guide_bookings (status);
create index if not exists guide_bookings_nationality_idx on public.guide_bookings (nationality);
create index if not exists guide_bookings_created_at_idx on public.guide_bookings (created_at desc);


-- What a guide reports to the office: a tour completed, a headcount, an
-- incident, or feedback a tourist gave them. `barangay` is where it happened,
-- set by the API from the booking's destination or the guide's own barangay,
-- never taken from the guide — it is what the office's per-barangay rollup
-- counts. Filing a report never changes a booking; the office does that.
create table if not exists public.guide_reports (
    id                  text primary key default public.ztims_new_id(),
    guide_id            text not null references public.tourist_guides (id) on delete cascade,
    booking_id          text references public.guide_bookings (id) on delete set null,
    report_type         text not null
                        constraint guide_reports_type
                        check (report_type in ('tour_completed', 'headcount', 'incident', 'tourist_feedback')),
    report_date         date not null,
    headcount           integer
                        constraint guide_reports_headcount check (headcount is null or headcount >= 0),
    barangay            text not null default '',
    details             text not null default ''
                        constraint guide_reports_details_length check (char_length(details) <= 2000),
    status              text not null default 'new'
                        constraint guide_reports_status check (status in ('new', 'reviewed')),
    reviewed_by_email   text not null default '',
    reviewed_at         timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists guide_reports_guide_idx on public.guide_reports (guide_id);
create index if not exists guide_reports_booking_idx on public.guide_reports (booking_id);
create index if not exists guide_reports_barangay_idx on public.guide_reports (barangay);
create index if not exists guide_reports_status_idx on public.guide_reports (status);
create index if not exists guide_reports_report_date_idx on public.guide_reports (report_date desc);

-- ---------------------------------------------------------------------------
-- Payments: a record of cash taken at the counter. ZTIMS takes no money
-- online. One payment per booking, enforced here rather than hoped for.
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
    id                  text primary key default public.ztims_new_id(),
    booking_id          text not null unique references public.guide_bookings (id),
    amount              numeric not null constraint payments_amount_not_negative check (amount >= 0),
    method              text not null default 'cash',
    receipt_number      text not null default '',
    paid_at             timestamptz not null default now(),
    -- Who took it, by id and by email, so the record outlives the account.
    recorded_by         text references public.tourism_officers (id) on delete set null,
    recorded_by_email   text not null default '',
    remarks             text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- Removing an officer clears recorded_by on their payments; this keeps that
-- from reading the whole table.
create index if not exists payments_recorded_by_idx on public.payments (recorded_by);


-- ---------------------------------------------------------------------------
-- Feedback from the public Contact Us page. Resolved, never deleted.
-- ---------------------------------------------------------------------------
create table if not exists public.feedback (
    id                      text primary key default public.ztims_new_id(),
    topic                   text not null default 'other'
                            constraint feedback_topic
                            check (topic in ('suggestion', 'listing', 'problem', 'booking', 'other')),
    message                 text not null
                            constraint feedback_message_length check (char_length(message) between 1 and 2000),
    name                    text not null default '' constraint feedback_name_length check (char_length(name) <= 120),
    email                   text not null default '' constraint feedback_email_length check (char_length(email) <= 254),
    page                    text not null default '' constraint feedback_page_length check (char_length(page) <= 500),
    status                  text not null default 'new'
                            constraint feedback_status check (status in ('new', 'read', 'resolved')),
    status_updated_at       timestamptz,
    status_updated_by_email text not null default '',
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now()
);

create index if not exists feedback_status_idx on public.feedback (status);
create index if not exists feedback_topic_idx on public.feedback (topic);
create index if not exists feedback_created_at_idx on public.feedback (created_at desc);


-- ---------------------------------------------------------------------------
-- Rate-limit counters, shared by every running copy of the API. Not data:
-- every row expires within an hour, and old ones are swept as the API runs.
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
    key                 text primary key,
    hits                integer not null,
    expires_at          timestamptz not null
);

create index if not exists rate_limits_expires_at_idx on public.rate_limits (expires_at);


-- ---------------------------------------------------------------------------
-- Tourism statistics: the monthly counts behind Form A4, "Report on the
-- Regional Distribution of Travelers", and visitor counts at attractions.
--
-- Counts only. There is no column for money (revenue, rates, fees taken) and
-- none for a guest's name or any detail about one person, and there must never
-- be one: an establishment reports how many guests came from where, nothing
-- more. There are no percentages either; every figure is a count, and every
-- total is added up when it is asked for, never stored.
--
-- Reports are kept for good. A report entered by mistake is voided, not
-- deleted, and every change is written to report_changes.
-- ---------------------------------------------------------------------------

-- The rows of Form A4, in the form's own order. Countries are keyed by their
-- two-letter ISO code; the form's other rows by a word. The pages read this
-- list from the API, so the form and the server can never disagree about it.
create table if not exists public.residences (
    code                text primary key,
    name                text not null,
    -- philippine: residents of the Philippines. foreign: non-Philippine
    -- residents, grouped by continent and region. overseas_filipino and
    -- unspecified: the form's last two rows.
    section             text not null
                        constraint residences_section
                        check (section in ('philippine', 'foreign', 'overseas_filipino', 'unspecified')),
    continent           text not null,
    region              text not null,
    sort_order          integer not null
);

insert into public.residences (code, name, section, continent, region, sort_order) values
    ('ph-filipino', 'Filipino nationality', 'philippine', 'Philippine residents', 'Philippine residents', 10),
    ('ph-foreign', 'Foreign nationality', 'philippine', 'Philippine residents', 'Philippine residents', 20),
    ('BN', 'Brunei', 'foreign', 'Asia', 'ASEAN', 30),
    ('KH', 'Cambodia', 'foreign', 'Asia', 'ASEAN', 40),
    ('ID', 'Indonesia', 'foreign', 'Asia', 'ASEAN', 50),
    ('LA', 'Laos', 'foreign', 'Asia', 'ASEAN', 60),
    ('MY', 'Malaysia', 'foreign', 'Asia', 'ASEAN', 70),
    ('MM', 'Myanmar', 'foreign', 'Asia', 'ASEAN', 80),
    ('SG', 'Singapore', 'foreign', 'Asia', 'ASEAN', 90),
    ('TH', 'Thailand', 'foreign', 'Asia', 'ASEAN', 100),
    ('VN', 'Vietnam', 'foreign', 'Asia', 'ASEAN', 110),
    ('CN', 'China', 'foreign', 'Asia', 'East Asia', 120),
    ('HK', 'Hong Kong', 'foreign', 'Asia', 'East Asia', 130),
    ('JP', 'Japan', 'foreign', 'Asia', 'East Asia', 140),
    ('KR', 'Korea', 'foreign', 'Asia', 'East Asia', 150),
    ('MO', 'Macau', 'foreign', 'Asia', 'East Asia', 160),
    ('TW', 'Taiwan', 'foreign', 'Asia', 'East Asia', 170),
    ('BD', 'Bangladesh', 'foreign', 'Asia', 'South Asia', 180),
    ('IN', 'India', 'foreign', 'Asia', 'South Asia', 190),
    ('IR', 'Iran', 'foreign', 'Asia', 'South Asia', 200),
    ('NP', 'Nepal', 'foreign', 'Asia', 'South Asia', 210),
    ('PK', 'Pakistan', 'foreign', 'Asia', 'South Asia', 220),
    ('LK', 'Sri Lanka', 'foreign', 'Asia', 'South Asia', 230),
    ('BH', 'Bahrain', 'foreign', 'Asia', 'Middle East', 240),
    ('EG', 'Egypt', 'foreign', 'Asia', 'Middle East', 250),
    ('OM', 'Oman', 'foreign', 'Asia', 'Middle East', 260),
    ('JO', 'Jordan', 'foreign', 'Asia', 'Middle East', 270),
    ('KW', 'Kuwait', 'foreign', 'Asia', 'Middle East', 280),
    ('QA', 'Qatar', 'foreign', 'Asia', 'Middle East', 290),
    ('SA', 'Saudi Arabia', 'foreign', 'Asia', 'Middle East', 300),
    ('AE', 'United Arab Emirates', 'foreign', 'Asia', 'Middle East', 310),
    ('CA', 'Canada', 'foreign', 'America', 'North America', 320),
    ('MX', 'Mexico', 'foreign', 'America', 'North America', 330),
    ('US', 'USA', 'foreign', 'America', 'North America', 340),
    ('AR', 'Argentina', 'foreign', 'America', 'South America', 350),
    ('BR', 'Brazil', 'foreign', 'America', 'South America', 360),
    ('CO', 'Colombia', 'foreign', 'America', 'South America', 370),
    ('PE', 'Peru', 'foreign', 'America', 'South America', 380),
    ('VE', 'Venezuela', 'foreign', 'America', 'South America', 390),
    ('AD', 'Andorra', 'foreign', 'Europe', 'Western Europe', 400),
    ('AT', 'Austria', 'foreign', 'Europe', 'Western Europe', 410),
    ('BE', 'Belgium', 'foreign', 'Europe', 'Western Europe', 420),
    ('FR', 'France', 'foreign', 'Europe', 'Western Europe', 430),
    ('DE', 'Germany', 'foreign', 'Europe', 'Western Europe', 440),
    ('LU', 'Luxembourg', 'foreign', 'Europe', 'Western Europe', 450),
    ('NL', 'Netherlands', 'foreign', 'Europe', 'Western Europe', 460),
    ('CH', 'Switzerland', 'foreign', 'Europe', 'Western Europe', 470),
    ('DK', 'Denmark', 'foreign', 'Europe', 'Northern Europe', 480),
    ('FI', 'Finland', 'foreign', 'Europe', 'Northern Europe', 490),
    ('IE', 'Ireland', 'foreign', 'Europe', 'Northern Europe', 500),
    ('NO', 'Norway', 'foreign', 'Europe', 'Northern Europe', 510),
    ('SE', 'Sweden', 'foreign', 'Europe', 'Northern Europe', 520),
    ('GB', 'United Kingdom', 'foreign', 'Europe', 'Northern Europe', 530),
    ('GR', 'Greece', 'foreign', 'Europe', 'Southern Europe', 540),
    ('IT', 'Italy', 'foreign', 'Europe', 'Southern Europe', 550),
    ('PT', 'Portugal', 'foreign', 'Europe', 'Southern Europe', 560),
    ('ES', 'Spain', 'foreign', 'Europe', 'Southern Europe', 570),
    ('cis', 'Commonwealth of Independent States', 'foreign', 'Europe', 'Eastern Europe', 580),
    ('PL', 'Poland', 'foreign', 'Europe', 'Eastern Europe', 590),
    ('RU', 'Russia', 'foreign', 'Europe', 'Eastern Europe', 600),
    ('IL', 'Israel', 'foreign', 'Europe', 'East Mediterranean Europe', 610),
    ('TR', 'Turkey', 'foreign', 'Europe', 'East Mediterranean Europe', 620),
    ('AU', 'Australia', 'foreign', 'Australasia / Pacific', 'Australasia / Pacific', 630),
    ('GU', 'Guam', 'foreign', 'Australasia / Pacific', 'Australasia / Pacific', 640),
    ('NR', 'Nauru', 'foreign', 'Australasia / Pacific', 'Australasia / Pacific', 650),
    ('NZ', 'New Zealand', 'foreign', 'Australasia / Pacific', 'Australasia / Pacific', 660),
    ('PG', 'Papua New Guinea', 'foreign', 'Australasia / Pacific', 'Australasia / Pacific', 670),
    ('NG', 'Nigeria', 'foreign', 'Africa', 'Africa', 680),
    ('ZA', 'South Africa', 'foreign', 'Africa', 'Africa', 690),
    ('other-foreign', 'Others / unspecified', 'foreign', 'Others', 'Others and unspecified', 700),
    ('overseas-filipino', 'Overseas Filipinos', 'overseas_filipino', 'Overseas Filipinos', 'Overseas Filipinos', 710),
    ('unspecified', 'Unspecified residence', 'unspecified', 'Unspecified residence', 'Unspecified residence', 720)
on conflict (code) do update set
    name = excluded.name, section = excluded.section, continent = excluded.continent,
    region = excluded.region, sort_order = excluded.sort_order;

-- One report per place per month: an accommodation's guests, rooms and nights,
-- or an attraction's visitors. A 'municipal_total' report belongs to no place:
-- it holds a month from before ZTIMS collected per place (the 2025 sheet),
-- already added up for the whole municipality.
create table if not exists public.monthly_reports (
    id                  text primary key default public.ztims_new_id(),
    kind                text not null
                        constraint monthly_reports_kind
                        check (kind in ('accommodation', 'attraction', 'municipal_total')),
    spot_id             text references public.spots (id),
    year                integer not null constraint monthly_reports_year check (year between 2000 and 2100),
    month               integer not null constraint monthly_reports_month check (month between 1 and 12),
    -- Accommodations only (and municipal totals). An attraction has visitors,
    -- not rooms or nights.
    rooms               integer constraint monthly_reports_rooms check (rooms is null or rooms >= 0),
    room_nights_occupied integer
                        constraint monthly_reports_room_nights check (room_nights_occupied is null or room_nights_occupied >= 0),
    guest_nights        integer constraint monthly_reports_guest_nights check (guest_nights is null or guest_nights >= 0),
    status              text not null default 'submitted'
                        constraint monthly_reports_status check (status in ('submitted', 'void')),
    void_reason         text not null default '',
    -- Who sent it, by id and by email, so the record outlives the account.
    submitted_by_role   text not null default '',
    submitted_by_id     text not null default '',
    submitted_by_email  text not null default '',
    submitted_at        timestamptz not null default now(),
    -- Set when the officer marks the month as sent to the province. A locked
    -- report is changed only after the officer unlocks it.
    locked_at           timestamptz,
    locked_by_email     text not null default '',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint monthly_reports_place check ((kind = 'municipal_total') = (spot_id is null)),
    constraint monthly_reports_attraction_counts_only
        check (kind <> 'attraction' or (rooms is null and room_nights_occupied is null and guest_nights is null)),
    -- Room-nights occupied can never be more than rooms × days in the month.
    constraint monthly_reports_room_nights_fit
        check (room_nights_occupied is null or rooms is null or room_nights_occupied <=
               rooms * extract(day from (make_date(year, month, 1) + interval '1 month' - interval '1 day')))
);

-- A voided report stays, but only one live report per place and month.
create unique index if not exists monthly_reports_one_per_place
    on public.monthly_reports (spot_id, year, month) where status = 'submitted' and spot_id is not null;
create unique index if not exists monthly_reports_one_municipal_total
    on public.monthly_reports (year, month) where status = 'submitted' and kind = 'municipal_total';
create index if not exists monthly_reports_period_idx on public.monthly_reports (year, month);
create index if not exists monthly_reports_spot_idx on public.monthly_reports (spot_id);

-- A report's numbers: one row per residence that had anyone. Male and female
-- are both given, or (for the 2025 sheet, which never split by sex) neither.
create table if not exists public.monthly_report_counts (
    report_id           text not null references public.monthly_reports (id),
    residence_code      text not null references public.residences (code),
    male                integer constraint monthly_report_counts_male check (male is null or male >= 0),
    female              integer constraint monthly_report_counts_female check (female is null or female >= 0),
    total               integer not null constraint monthly_report_counts_total check (total >= 0),
    primary key (report_id, residence_code),
    constraint monthly_report_counts_sex_adds_up
        check ((male is null and female is null) or (male is not null and female is not null and male + female = total))
);

create index if not exists monthly_report_counts_residence_idx on public.monthly_report_counts (residence_code);

-- Every change to a report: what it was, what it became, who and when.
create table if not exists public.report_changes (
    id                  text primary key default public.ztims_new_id(),
    report_id           text not null references public.monthly_reports (id),
    action              text not null
                        constraint report_changes_action
                        check (action in ('created', 'updated', 'voided', 'locked', 'unlocked')),
    changed_by_role     text not null default '',
    changed_by_email    text not null default '',
    note                text not null default '' constraint report_changes_note_length check (char_length(note) <= 500),
    before              jsonb,
    after               jsonb,
    changed_at          timestamptz not null default now()
);

create index if not exists report_changes_report_idx on public.report_changes (report_id, changed_at desc);


-- ---------------------------------------------------------------------------
-- Online payments — a DEMONSTRATION, in the payment gateway's test mode.
--
-- A visitor may pay a guide booking, or buy an entrance ticket to an attraction
-- the office runs, through the gateway's checkout. The API refuses to start with
-- a live key, so no real money can move: every online payment is a test one.
-- Records made for the demonstration carry is_demo, and the officer can remove
-- them all at once. The gateway keeps the card and wallet details; nothing here
-- does. Money stays out of the statistics tables above.
-- ---------------------------------------------------------------------------

-- Demonstration bookings (seeded, or paid in test mode), removable together.
alter table public.guide_bookings add column if not exists is_demo boolean not null default false;

-- An entrance ticket: one date, one attraction, a number of people.
create table if not exists public.tickets (
    id                  text primary key default public.ztims_new_id(),
    -- What the visitor shows at the gate, e.g. JF-7K3M-Q. Unique for good.
    code                text not null unique,
    spot_id             text not null references public.spots (id),
    visit_date          date not null,
    people              integer not null constraint tickets_people check (people between 1 and 50),
    -- The entrance fee when bought, and the total, fixed at purchase.
    unit_fee            numeric not null constraint tickets_unit_fee check (unit_fee >= 0),
    amount              numeric not null constraint tickets_amount check (amount >= 0),
    full_name           text not null,
    email               text not null,
    contact_number      text not null default '',
    status              text not null default 'pending_payment'
                        constraint tickets_status
                        check (status in ('pending_payment', 'valid', 'used', 'cancelled', 'expired')),
    used_at             timestamptz,
    used_by_email       text not null default '',
    is_demo             boolean not null default false,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists tickets_spot_date_idx on public.tickets (spot_id, visit_date);
create index if not exists tickets_status_idx on public.tickets (status);

-- A payment is for one booking or one ticket. Online payments say so, keep the
-- gateway's reference, and may be refunded (the office cancelled).
alter table public.payments alter column booking_id drop not null;
alter table public.payments add column if not exists ticket_id text unique references public.tickets (id);
alter table public.payments add column if not exists channel text not null default 'counter';
alter table public.payments add column if not exists gateway_ref text not null default '';
alter table public.payments add column if not exists refunded_at timestamptz;
alter table public.payments add column if not exists refund_reason text not null default '';
alter table public.payments add column if not exists refunded_by_email text not null default '';
alter table public.payments add column if not exists is_demo boolean not null default false;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'payments_channel') then
        alter table public.payments add constraint payments_channel check (channel in ('counter', 'online'));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'payments_for_one') then
        alter table public.payments add constraint payments_for_one check ((booking_id is null) <> (ticket_id is null));
    end if;
end
$$;

create index if not exists payments_paid_at_idx on public.payments (paid_at desc);

-- One trip to the gateway's checkout page. Kept whatever became of it, so a
-- payment that arrives late, or twice, can still be matched to what it was for.
create table if not exists public.online_checkouts (
    id                  text primary key default public.ztims_new_id(),
    kind                text not null constraint online_checkouts_kind check (kind in ('guide_booking', 'ticket')),
    booking_id          text references public.guide_bookings (id) on delete cascade,
    ticket_id           text references public.tickets (id) on delete cascade,
    amount              numeric not null constraint online_checkouts_amount check (amount >= 0),
    session_id          text unique,
    checkout_url        text not null default '',
    status              text not null default 'pending'
                        constraint online_checkouts_status
                        check (status in ('pending', 'paid', 'expired', 'duplicate')),
    method              text not null default '',
    payment_ref         text not null default '',
    expires_at          timestamptz not null,
    paid_at             timestamptz,
    is_demo             boolean not null default true,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint online_checkouts_for_one check ((booking_id is null) <> (ticket_id is null))
);

create index if not exists online_checkouts_booking_idx on public.online_checkouts (booking_id);
create index if not exists online_checkouts_ticket_idx on public.online_checkouts (ticket_id);


-- ---------------------------------------------------------------------------
-- updated_at triggers, and Row Level Security on, with no policies, for all.
-- ---------------------------------------------------------------------------
do $$
declare
    t text;
begin
    foreach t in array array[
        'tourism_officers', 'establishment_managers', 'spots', 'tourist_guides',
        'guide_reports', 'guide_bookings', 'payments', 'feedback',
        'monthly_reports', 'tickets', 'online_checkouts'
    ] loop
        execute format('drop trigger if exists %I on public.%I', t || '_touch_updated_at', t);
        execute format(
            'create trigger %I before update on public.%I for each row execute function public.ztims_touch_updated_at()',
            t || '_touch_updated_at', t
        );
    end loop;

    foreach t in array array[
        'tourism_officers', 'establishment_managers', 'spots', 'tourist_guides', 'tourist_guide_spots',
        'languages', 'guide_languages', 'guide_reports', 'guide_bookings', 'payments', 'feedback', 'rate_limits',
        'residences', 'monthly_reports', 'monthly_report_counts', 'report_changes',
        'tickets', 'online_checkouts'
    ] loop
        execute format('alter table public.%I enable row level security', t);
    end loop;
end
$$;
