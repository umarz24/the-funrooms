-- ============================================================================
-- THE FUNROOMS — 02: accounts, cloud saves, Stripe credits
-- Run this in the Supabase SQL editor AFTER 01_scores.sql.
-- Safe to re-run: every statement is idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles: one row per signed-in player, holding the whole save as jsonb.
-- `credits` is coins bought with real money and is written ONLY by the server
-- (service role) — the player can read it but never set it.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text,
  save        jsonb not null default '{}'::jsonb,
  credits     bigint not null default 0,
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "own profile read"   on public.profiles;
drop policy if exists "own profile insert" on public.profiles;
drop policy if exists "own profile update" on public.profiles;

create policy "own profile read"
  on public.profiles for select
  using (auth.uid() = id);

create policy "own profile insert"
  on public.profiles for insert
  with check (auth.uid() = id);

-- The player may rewrite their save and name. `credits` is protected by the
-- trigger below rather than by the policy, because a column-level rule here
-- would also block the server's own writes.
create policy "own profile update"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create or replace function public.protect_credits()
returns trigger language plpgsql security definer as $$
begin
  -- Anything coming through PostgREST as an end user keeps the old credits.
  -- The service role bypasses RLS and runs as 'service_role', so it can change them.
  if current_setting('request.jwt.claims', true) is not null
     and coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role','') <> 'service_role'
  then
    new.credits := old.credits;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists protect_credits_trg on public.profiles;
create trigger protect_credits_trg
  before update on public.profiles
  for each row execute function public.protect_credits();

-- ---------------------------------------------------------------------------
-- add_credits: atomic increment used by the Stripe webhook.
-- ---------------------------------------------------------------------------
create or replace function public.add_credits(uid uuid, n bigint)
returns bigint language plpgsql security definer
set search_path = public as $$
declare total bigint;
begin
  insert into public.profiles (id, credits) values (uid, n)
  on conflict (id) do update set credits = public.profiles.credits + n
  returning credits into total;
  return total;
end $$;

revoke all on function public.add_credits(uuid, bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- stripe_events: one row per handled checkout session, so a webhook that
-- Stripe retries cannot credit the same purchase twice.
-- ---------------------------------------------------------------------------
create table if not exists public.stripe_events (
  id          text primary key,
  user_id     uuid,
  coins       bigint,
  created_at  timestamptz not null default now()
);
alter table public.stripe_events enable row level security;
-- No policies at all: only the service role (which bypasses RLS) touches this.

-- ---------------------------------------------------------------------------
-- scores: make leaderboard rows auth-bound.
-- Signed-in players must post as themselves. Anonymous runs are still allowed
-- with a null user_id — drop the second policy below if you want to require
-- an account to appear on the leaderboard at all.
-- ---------------------------------------------------------------------------
alter table public.scores add column if not exists user_id uuid references auth.users(id) on delete set null;
create index if not exists scores_user_id_idx on public.scores (user_id);

drop policy if exists "anyone can insert a score" on public.scores;
drop policy if exists "insert own score"          on public.scores;
drop policy if exists "insert anonymous score"    on public.scores;

create policy "insert own score"
  on public.scores for insert
  to authenticated
  with check (user_id = auth.uid());

-- Comment this one out to make an account mandatory for the leaderboard.
create policy "insert anonymous score"
  on public.scores for insert
  to anon
  with check (user_id is null);
