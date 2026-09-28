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

-- Single days a guide is off (leave, a fiesta, sick). Kept by the guide in the
-- portal; the office cannot assign them a booking on one of these dates.
create table if not exists public.guide_time_off (
    id                  text primary key default public.ztims_new_id(),
    guide_id            text not null references public.tourist_guides (id) on delete cascade,
    off_date            date not null,
    note                text not null default ''
                        constraint guide_time_off_note_length check (char_length(note) <= 200),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint guide_time_off_once_a_day unique (guide_id, off_date)
);

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

-- A guide cannot change their own record: they ask, and the office approves.
-- `changes` holds only the fields a guide may propose (contact number, bio).
-- One open request per guide at a time.
create table if not exists public.guide_profile_requests (
    id                  text primary key default public.ztims_new_id(),
    guide_id            text not null references public.tourist_guides (id) on delete cascade,
    changes             jsonb not null,
    note                text not null default ''
                        constraint guide_profile_requests_note_length check (char_length(note) <= 500),
    status              text not null default 'pending'
                        constraint guide_profile_requests_status check (status in ('pending', 'approved', 'rejected')),
    review_note         text not null default '',
    reviewed_by_email   text not null default '',
    reviewed_at         timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create unique index if not exists guide_profile_requests_one_pending
    on public.guide_profile_requests (guide_id) where status = 'pending';
create index if not exists guide_profile_requests_status_idx on public.guide_profile_requests (status);

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
-- updated_at triggers, and Row Level Security on, with no policies, for all.
-- ---------------------------------------------------------------------------
do $$
declare
    t text;
begin
    foreach t in array array[
        'tourism_officers', 'establishment_managers', 'spots', 'tourist_guides',
        'guide_time_off', 'guide_reports', 'guide_profile_requests', 'guide_bookings', 'payments', 'feedback'
    ] loop
        execute format('drop trigger if exists %I on public.%I', t || '_touch_updated_at', t);
        execute format(
            'create trigger %I before update on public.%I for each row execute function public.ztims_touch_updated_at()',
            t || '_touch_updated_at', t
        );
    end loop;

    foreach t in array array[
        'tourism_officers', 'establishment_managers', 'spots', 'tourist_guides', 'tourist_guide_spots',
        'guide_time_off', 'languages', 'guide_languages', 'guide_reports', 'guide_profile_requests', 'guide_bookings', 'payments', 'feedback', 'rate_limits'
    ] loop
        execute format('alter table public.%I enable row level security', t);
    end loop;
end
$$;
