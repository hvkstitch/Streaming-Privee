-- Migration Supabase pour MaCinémathèque + Terabox
-- À exécuter dans Dashboard → SQL Editor

-- Créer la table movies
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

-- Activer Row Level Security
ALTER TABLE movies ENABLE ROW LEVEL SECURITY;

-- Policies publiques (accès sans authentification)
CREATE POLICY "Public read"   ON movies FOR SELECT USING (true);
CREATE POLICY "Public insert" ON movies FOR INSERT WITH CHECK (true);
CREATE POLICY "Public delete" ON movies FOR DELETE USING (true);
