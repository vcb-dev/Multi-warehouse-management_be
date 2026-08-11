-- Ensure PRIMARY KEY (variant_id, location_id) on inventory_levels.
--
-- Migration 20260728040000_sapo_locations_merge already added this PK on DBs that
-- ran it successfully. Re-adding blindly fails with 42P16 ("multiple primary keys
-- are not allowed"). Only create the constraint when the table has no primary key.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.inventory_levels'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE "inventory_levels"
      ADD CONSTRAINT "inventory_levels_pkey" PRIMARY KEY ("variant_id", "location_id");
  END IF;
END $$;
