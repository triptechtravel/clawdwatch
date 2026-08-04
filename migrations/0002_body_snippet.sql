-- Diagnostic body capture for FAILING checks.
--
-- 0001 stated that check_results stores no response bodies. That default is
-- unchanged: capture_body_on_failure is 0 for every existing and new check
-- unless its owner opts in, body_snippet stays NULL for passing checks, and
-- what is stored is truncated and run through the secret scrubber first.
--
-- The motivating case: a health endpoint that returned a 500 whose body named
-- the failing dependency, while the alert carried only "expected 200, got
-- 500". The cause was sitting in a response nobody kept.

ALTER TABLE checks ADD COLUMN capture_body_on_failure INTEGER NOT NULL DEFAULT 0;

ALTER TABLE check_results ADD COLUMN body_snippet TEXT;
