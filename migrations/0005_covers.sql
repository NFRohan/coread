-- Book covers, looked up on Open Library from the title/author (or set by hand).
ALTER TABLE books ADD COLUMN cover_url TEXT;
ALTER TABLE books ADD COLUMN cover_source TEXT;      -- 'openlibrary' | 'manual' | 'none' (looked up, nothing found)
ALTER TABLE books ADD COLUMN cover_query TEXT;       -- the title the lookup used; a new title triggers a new lookup
ALTER TABLE books ADD COLUMN cover_checked_at INTEGER;

ALTER TABLE wishlist ADD COLUMN cover_url TEXT;
