-- Optional referral attribution for inbound leads. The marketing "Request
-- Access" form now asks "Were you referred by a company using SOLVE?" and passes
-- the free-text answer as `referred_by`. It is surfaced in the Vault admin
-- contacts view so an admin can manually verify and apply the $100 referral
-- credit; there is no automated referral-credit calculation.

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "referred_by" text;
