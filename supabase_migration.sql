-- Migration Supabase pour Terabox
-- À exécuter dans Dashboard → SQL Editor

-- Ajouter les colonnes Terabox à la table movies existante
ALTER TABLE movies
  ADD COLUMN IF NOT EXISTS terabox_path TEXT,
  ADD COLUMN IF NOT EXISTS fs_id        BIGINT;

-- Si tu pars de zéro (nouvelle table) :
/*
CREATE TABLE IF NOT EXISTS movies (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  title        TEXT NOT NULL,
  size         BIGINT NOT NULL,
  ext          TEXT NOT NULL,
  added        TEXT NOT NULL,
  terabox_path TEXT,
  fs_id        BIGINT,
  added_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE movies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read"   ON movies FOR SELECT USING (true);
CREATE POLICY "Public insert" ON movies FOR INSERT WITH CHECK (true);
CREATE POLICY "Public delete" ON movies FOR DELETE USING (true);
*/
