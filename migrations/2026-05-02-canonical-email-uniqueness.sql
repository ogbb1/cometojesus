-- ============================================================
-- Come to Jesus: block duplicate signups via canonical email
-- Run this in Supabase SQL Editor
-- Safe to re-run (CREATE OR REPLACE / DROP TRIGGER IF EXISTS)
-- ============================================================
--
-- Why this exists:
-- Gmail plus-addressing (oskar@gmail.com, oskar+1@gmail.com,
-- oskar+2@gmail.com) all deliver to the same inbox but Supabase
-- Auth treats them as distinct accounts. A single user could
-- spin up unlimited fake accounts and farm 25 free messages each.
-- Same problem with dot-tricks in the local part (o.skar@gmail.com
-- vs oskar@gmail.com both reach oskar@gmail.com on Gmail).
--
-- This migration adds:
--   1. canonicalize_email(text) function that normalizes an address
--      to lowercase, strips +tag, and (for Gmail) strips dots from
--      the local part.
--   2. A BEFORE INSERT trigger on auth.users that rejects any new
--      signup whose canonical form already matches an existing user.
--
-- Existing duplicates are NOT cleaned up by this migration; only
-- new signups are blocked going forward. If a backfill is needed,
-- run admin SQL to identify and merge duplicates manually.

-- ----- Part 1: canonicalize_email -----

CREATE OR REPLACE FUNCTION canonicalize_email(p_email TEXT)
RETURNS TEXT AS $$
DECLARE
  local_part TEXT;
  domain_part TEXT;
  is_gmail BOOLEAN;
BEGIN
  IF p_email IS NULL THEN
    RETURN NULL;
  END IF;
  p_email := lower(trim(p_email));
  local_part := split_part(p_email, '@', 1);
  domain_part := split_part(p_email, '@', 2);
  IF local_part = '' OR domain_part = '' THEN
    RETURN p_email;
  END IF;
  -- Strip plus-tags from local part (everything from + onwards).
  local_part := split_part(local_part, '+', 1);
  -- Gmail and Google Workspace: dots in the local part are ignored
  -- by Google's mail routing.
  is_gmail := domain_part IN ('gmail.com', 'googlemail.com');
  IF is_gmail THEN
    local_part := replace(local_part, '.', '');
  END IF;
  RETURN local_part || '@' || domain_part;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ----- Part 2: trigger to block duplicate canonical emails -----

CREATE OR REPLACE FUNCTION block_duplicate_canonical_email()
RETURNS TRIGGER AS $$
DECLARE
  canon TEXT;
  duplicate_count INT;
BEGIN
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;
  canon := canonicalize_email(NEW.email);
  SELECT COUNT(*) INTO duplicate_count
  FROM auth.users
  WHERE id != NEW.id
    AND canonicalize_email(email) = canon;
  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'An account with this email already exists.'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS prevent_duplicate_canonical_email ON auth.users;
CREATE TRIGGER prevent_duplicate_canonical_email
BEFORE INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION block_duplicate_canonical_email();


-- ============================================================
-- Verification (optional, run after applying):
-- ============================================================
-- SELECT canonicalize_email('Oskar+test1@gmail.com'); -- expect 'oskar@gmail.com'
-- SELECT canonicalize_email('o.skar+x@gmail.com');    -- expect 'oskar@gmail.com'
-- SELECT canonicalize_email('user+x@protonmail.com'); -- expect 'user@protonmail.com'
-- SELECT canonicalize_email('user@protonmail.com');   -- expect 'user@protonmail.com'

-- ============================================================
-- Find existing duplicates (admin tool, run anytime):
-- ============================================================
-- SELECT canonicalize_email(email) AS canonical, COUNT(*) AS dupes,
--        ARRAY_AGG(email) AS variants
-- FROM auth.users
-- GROUP BY canonical
-- HAVING COUNT(*) > 1
-- ORDER BY dupes DESC;
