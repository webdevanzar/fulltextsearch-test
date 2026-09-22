-- ============================================================================
-- 0_init — Category / SubCategory / Listing schema + indexing
-- (mirrors prisma/schema.prisma)
-- ============================================================================

-- CreateTable
CREATE TABLE "categories" (
    "id"   TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateTable
CREATE TABLE "sub_categories" (
    "id"         TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,

    CONSTRAINT "sub_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sub_categories_categoryId_name_key" ON "sub_categories"("categoryId", "name");
CREATE INDEX "sub_categories_categoryId_idx" ON "sub_categories"("categoryId");

ALTER TABLE "sub_categories"
    ADD CONSTRAINT "sub_categories_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "listings" (
    "id"            TEXT NOT NULL,
    "title"         TEXT NOT NULL,
    "description"   TEXT NOT NULL,
    "price"         DECIMAL(10,2) NOT NULL,
    "categoryId"    TEXT NOT NULL,
    "subCategoryId" TEXT NOT NULL,
    "customData"    JSONB NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "listings"
    ADD CONSTRAINT "listings_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "listings"
    ADD CONSTRAINT "listings_subCategoryId_fkey"
    FOREIGN KEY ("subCategoryId") REFERENCES "sub_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Relational indexes (B-Tree)
-- ============================================================================

CREATE INDEX "listings_categoryId_idx"    ON "listings"("categoryId");
CREATE INDEX "listings_subCategoryId_idx" ON "listings"("subCategoryId");

-- ============================================================================
-- JSONB index — Prisma native syntax: @@index([customData], type: Gin)
--
-- IMPORTANT (read before interpreting the benchmark): this is a plain
-- GIN index with the default `jsonb_ops` operator class. It accelerates
-- containment/existence operators — `@>`, `?`, `?|`, `?&` — e.g.
-- `customData @> '{"brand":"Toyota"}'`.
--
-- It does NOT accelerate the SQL Prisma actually generates for its native
-- `path` + `equals`/`gt`/`gte` JSON filters. On Postgres, Prisma extracts
-- the path as text (functionally: `customData #>> '{brand}' = 'Toyota'`,
-- or cast to numeric for range comparisons) rather than using `@>`
-- containment — and a `jsonb_ops` GIN index cannot serve a `#>>` text
-- extraction or a numeric-cast range comparison at all. In other words:
-- the index this migration was asked to build, and the index Prisma's own
-- JSON filter API can actually use, are not the same thing. The benchmark
-- (src/search-analysis.ts) and README both call this out explicitly — it is the
-- single most important "computational complexity" finding this testbed
-- surfaces, not a bug to silently work around here.
-- ============================================================================

CREATE INDEX "listings_customData_idx" ON "listings" USING GIN ("customData");

-- ============================================================================
-- Full-text search indexing
--
-- Prisma's `search` filter emits to_tsvector("column") @@ to_tsquery($1) —
-- the 1-argument form of to_tsvector, with NO explicit text-search-config.
-- That form resolves the config from the `default_text_search_config` GUC
-- AT QUERY TIME, which makes it Postgres-classified STABLE, not IMMUTABLE.
--
-- Postgres requires index expressions to be IMMUTABLE (deterministic for
-- given input, independent of session/runtime settings) — so a GIN index
-- on to_tsvector(title) is not just unhelpful, it is IMPOSSIBLE to create;
-- Postgres raises `42P17 functions in index expression must be marked
-- IMMUTABLE` if you try (this migration originally did, and failed exactly
-- that way). In other words: as currently implemented, Prisma's native
-- `search` filter on Postgres can NEVER be backed by an index — this is a
-- structural limitation, not a missing-index bug, and it's arguably the
-- single most important "computational complexity" finding this testbed
-- surfaces. src/search-analysis.ts and README.md both call this out explicitly.
--
-- The only way to get an indexable tsvector expression is to pin the
-- config to a literal (e.g. 'english'), which is immutable because it's
-- fixed at index-creation time. That only works via raw SQL / a generated
-- column — never through Prisma's `search` filter as-is.
-- ============================================================================

-- Combined generated column + GIN index — the "properly designed" single
-- production index for multi-column search, used by the raw EXPLAIN ANALYZE
-- demonstration in src/search-analysis.ts to show a clean BitmapAnd/BitmapOr plan.
-- Note this is NOT reachable via Prisma's `search` filter (see above) —
-- only via raw SQL using to_tsvector('english', ...) / the search_vector
-- column directly.
ALTER TABLE "listings"
    ADD COLUMN "search_vector" tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
    ) STORED;

CREATE INDEX "listings_search_vector_idx" ON "listings" USING GIN ("search_vector");
