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
-- Tourist guides: municipal records, not accounts. Guides do not sign in.
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
        'guide_bookings', 'payments', 'feedback'
    ] loop
        execute format('drop trigger if exists %I on public.%I', t || '_touch_updated_at', t);
        execute format(
            'create trigger %I before update on public.%I for each row execute function public.ztims_touch_updated_at()',
            t || '_touch_updated_at', t
        );
    end loop;

    foreach t in array array[
        'tourism_officers', 'establishment_managers', 'spots', 'tourist_guides', 'tourist_guide_spots',
        'guide_bookings', 'payments', 'feedback', 'rate_limits'
    ] loop
        execute format('alter table public.%I enable row level security', t);
    end loop;
end
$$;
