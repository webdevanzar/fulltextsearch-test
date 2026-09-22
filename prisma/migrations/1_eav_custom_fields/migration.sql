-- ============================================================================
-- 1_eav_custom_fields — a FULLY INDEPENDENT EAV (Entity-Attribute-Value)
-- alternative to the JSONB `customData` column on "listings" (see 0_init).
--
-- No foreign keys cross between this table set and the JSONB one. Every
-- table here is prefixed/named distinctly (eav_categories, eav_listings,
-- custom_fields, sub_category_fields, listing_field_values) so the two
-- storage strategies can be seeded and benchmarked head-to-head without any
-- shared state. See src/eav-search-analysis.ts and README.md.
-- ============================================================================

-- CreateTable
CREATE TABLE "eav_categories" (
    "id"   TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "eav_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "eav_categories_name_key" ON "eav_categories"("name");

-- CreateTable
CREATE TABLE "eav_sub_categories" (
    "id"         TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,

    CONSTRAINT "eav_sub_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "eav_sub_categories_categoryId_name_key" ON "eav_sub_categories"("categoryId", "name");
CREATE INDEX "eav_sub_categories_categoryId_idx" ON "eav_sub_categories"("categoryId");

ALTER TABLE "eav_sub_categories"
    ADD CONSTRAINT "eav_sub_categories_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "eav_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "eav_listings" (
    "id"            TEXT NOT NULL,
    "title"         TEXT NOT NULL,
    "description"   TEXT NOT NULL,
    "price"         DECIMAL(10,2) NOT NULL,
    "categoryId"    TEXT NOT NULL,
    "subCategoryId" TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eav_listings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "eav_listings_categoryId_idx"    ON "eav_listings"("categoryId");
CREATE INDEX "eav_listings_subCategoryId_idx" ON "eav_listings"("subCategoryId");

ALTER TABLE "eav_listings"
    ADD CONSTRAINT "eav_listings_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "eav_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "eav_listings"
    ADD CONSTRAINT "eav_listings_subCategoryId_fkey"
    FOREIGN KEY ("subCategoryId") REFERENCES "eav_sub_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Full-text search support on the EAV listing table too, for parity with
-- "listings" — same immutable-expression discipline as 0_init: explicit
-- 'english' config so the expression is IMMUTABLE and therefore indexable.
ALTER TABLE "eav_listings"
    ADD COLUMN "search_vector" tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
    ) STORED;

CREATE INDEX "eav_listings_search_vector_idx" ON "eav_listings" USING GIN ("search_vector");

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'SELECT');

-- CreateTable
CREATE TABLE "custom_fields" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "label"     TEXT NOT NULL,
    "type"      "FieldType" NOT NULL,
    "options"   JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_fields_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_fields_name_key" ON "custom_fields"("name");

-- CreateTable
CREATE TABLE "sub_category_fields" (
    "id"            TEXT NOT NULL,
    "subCategoryId" TEXT NOT NULL,
    "customFieldId" TEXT NOT NULL,

    CONSTRAINT "sub_category_fields_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sub_category_fields_subCategoryId_customFieldId_key" ON "sub_category_fields"("subCategoryId", "customFieldId");
CREATE INDEX "sub_category_fields_subCategoryId_idx" ON "sub_category_fields"("subCategoryId");

ALTER TABLE "sub_category_fields"
    ADD CONSTRAINT "sub_category_fields_subCategoryId_fkey"
    FOREIGN KEY ("subCategoryId") REFERENCES "eav_sub_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sub_category_fields"
    ADD CONSTRAINT "sub_category_fields_customFieldId_fkey"
    FOREIGN KEY ("customFieldId") REFERENCES "custom_fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
--
-- Typed value columns (valueText / valueNumber / valueBoolean) instead of a
-- single TEXT column — a naive single-column EAV can't do an indexed numeric
-- range query at all (everything needs a cast at query time). This "wide
-- EAV" layout is what makes the year>=2020-style benchmark scenario fair.
CREATE TABLE "listing_field_values" (
    "id"            TEXT NOT NULL,
    "listingId"     TEXT NOT NULL,
    "customFieldId" TEXT NOT NULL,
    "valueText"     TEXT,
    "valueNumber"   DECIMAL(20,6),
    "valueBoolean"  BOOLEAN,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_field_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "listing_field_values_listingId_customFieldId_key" ON "listing_field_values"("listingId", "customFieldId");

-- Composite B-Tree indexes: (customFieldId, valueText) supports indexed
-- equality lookups (e.g. brand = 'Toyota'); (customFieldId, valueNumber)
-- supports indexed EQUALITY *and* RANGE lookups (e.g. year >= 2020) — the
-- one thing the JSONB jsonb_ops GIN index structurally cannot do at all.
CREATE INDEX "listing_field_values_customFieldId_valueText_idx"   ON "listing_field_values"("customFieldId", "valueText");
CREATE INDEX "listing_field_values_customFieldId_valueNumber_idx" ON "listing_field_values"("customFieldId", "valueNumber");

ALTER TABLE "listing_field_values"
    ADD CONSTRAINT "listing_field_values_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES "eav_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "listing_field_values"
    ADD CONSTRAINT "listing_field_values_customFieldId_fkey"
    FOREIGN KEY ("customFieldId") REFERENCES "custom_fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
