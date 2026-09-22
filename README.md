# Prisma FTS + JSONB + EAV + Relational Filtering Benchmark

A Dockerized testbed analyzing the computational complexity of combined
**category/subcategory (relational)**, **dynamic custom-field filtering**,
and **full-text search** with Prisma against PostgreSQL 15 — comparing two
completely independent storage strategies for the dynamic custom fields:
**JSONB** vs. **EAV (Entity-Attribute-Value)**.

> Want the short version? See [`MANUAL.md`](MANUAL.md) for a 3-command
> quick start. This file is the full technical write-up.

## What's in here

```
docker-compose.yml                      Postgres 15 + Node service
Dockerfile                              Node 20 image for the app service
MANUAL.md                               Short quick-start guide
prisma/schema.prisma                    Both table sets (see below)
prisma/migrations/0_init/               JSONB structure: Category/SubCategory/Listing
prisma/migrations/1_eav_custom_fields/  EAV structure: EavCategory/.../CustomField/ListingFieldValue
src/lib/listing-content.ts              Shared listing generator (used by both seed scripts, for apples-to-apples data)
src/lib/bench.ts                        Shared benchmarking/EXPLAIN harness (used by both analysis scripts)
src/seed.ts                             Seeds the JSONB structure — 100,000 listings
src/eav-seed.ts                         Seeds the EAV structure — 100,000 listings + field-value rows
src/search-analysis.ts                  JSONB analysis — 7 scenarios + EXPLAIN ANALYZE
src/eav-search-analysis.ts              EAV analysis — the same 7 scenarios + EXPLAIN ANALYZE
```

## Two independent structures — no shared tables

This project seeds and analyzes **two completely separate table sets**
for the same kind of data, so they can be compared head-to-head with zero
cross-contamination:

| | JSONB structure | EAV structure |
|---|---|---|
| Tables | `categories`, `sub_categories`, `listings` | `eav_categories`, `eav_sub_categories`, `eav_listings`, `custom_fields`, `sub_category_fields`, `listing_field_values` |
| Custom attributes | `listings.customData` (JSONB blob) | rows in `listing_field_values`, one per (listing, field) |
| Seed command | `npm run docker:seed` | `npm run docker:eav-seed` |
| Analysis command | `npm run docker:search-analysis` | `npm run docker:eav-search-analysis` |

Both use `src/lib/listing-content.ts` to generate listings, so the two
datasets are **statistically equivalent** (same brand/color distributions,
same "Toyota"/"Silver" weighting) even though nothing is literally shared —
that's what makes timing numbers between the two comparable.

## Schema

- **Category** (`Motors`, `Real Estate`, `Gadgets`, `Furniture`, `Fashion`) — 5 rows.
- **SubCategory** — 3 per category, 15 rows total (e.g. Motors → Sedans/SUVs/Motorcycles).
- **Listing** (JSONB structure) / **EavListing** (EAV structure) — 100,000 rows
  each, belonging to one category + one subcategory. Attribute shape depends
  on category:
  - Motors: `{"brand": "Toyota", "year": 2021, "mileage": 45000}`
  - Real Estate: `{"bedrooms": 3, "bathrooms": 2, "sqft": 1500, "furnished": true}`
  - Gadgets: `{"brand": "Apple", "ram": "16GB", "storage": "512GB"}`
  - Furniture: `{"material": "Oak", "color": "Brown", "assemblyRequired": true}`
  - Fashion: `{"size": "M", "color": "Black", "material": "Cotton"}`

  Motors listings deliberately mix "Toyota" and "Silver" at meaningful,
  independently-tunable rates (`src/lib/listing-content.ts`) so the combined
  FTS + attribute scenarios return non-trivial result sets.

## Indexing strategy — read this before interpreting results

This is the most important thing this testbed demonstrates, and it's a
genuine gotcha, not a hypothetical: **the GIN index Prisma's schema syntax
builds on `customData`, and the SQL Prisma's own JSON filter API generates
against that same column, don't line up.**

- `@@index([customData], type: Gin)` creates a **plain `jsonb_ops` GIN
  index**. That operator class only accelerates containment/existence
  operators: `@>`, `?`, `?|`, `?&` (e.g. `customData @> '{"brand":"Toyota"}'`).
- Prisma's native `customData: { path: ['brand'], equals: 'Toyota' }` filter
  compiles, on Postgres, to a **text-extraction comparison** — functionally
  `"customData"#>>'{brand}' = 'Toyota'` (and a numeric cast for range ops
  like `gte`). A `jsonb_ops` GIN index **cannot serve that operator at
  all** — not "it's slower," it is structurally unusable by the planner.
  Range comparisons (`gte`/`lte`) are doubly unindexable this way: even
  `@>` containment doesn't support ranges.

So the JSON exact-match and range scenarios, run through Prisma's own JSON
filter API, will generally **not** use the `customData` GIN index — only
the B-Tree on `categoryId` is available to them. This is printed and
labeled explicitly in the analysis output and is the headline
"computational complexity" finding, not noise to explain away.

Full-text search has an even sharper version of the same problem. Prisma's
`search` filter emits the **1-argument** form, `to_tsvector(title)`, with
no explicit language config — it resolves the config from the database's
`default_text_search_config` setting *at query time*. Because that setting
can change between queries, Postgres classifies the expression `STABLE`,
not `IMMUTABLE` — and Postgres flatly **refuses to create an index on a
non-immutable expression** (`42P17 functions in index expression must be
marked IMMUTABLE`). This isn't a missing-index situation; it's structurally
impossible to index. **Prisma's native `search` filter can never be backed
by a GIN index on Postgres, full stop** — the only way to get an indexable
tsvector expression is to pin the language to a literal (e.g. `'english'`),
which only works via raw SQL or a generated column, never through `search`
as written.

The `search_vector` generated column + GIN index below exists for exactly
that reason: it's the "properly designed" index a team would hand-build for
multi-column search, reachable only via raw SQL (see the EXPLAIN ANALYZE
output) — not via Prisma's ORM-level `search` filter.

| Index | Type | Backs |
|---|---|---|
| `listings_categoryId_idx` | B-Tree | `categoryId` filters (all scenarios) |
| `listings_subCategoryId_idx` | B-Tree | scenario 1 |
| `listings_customData_idx` | GIN (`jsonb_ops`) | only raw `@>` containment queries — **not** Prisma's `path`/`equals`/`gte` filters |
| `listings_search_vector_idx` | GIN | only the raw "indexed" scenario (row 7) — **not** reachable through Prisma's `search` filter |

### EAV indexing strategy — the contrast

`ListingFieldValue` uses **typed value columns** (`valueText` / `valueNumber`
/ `valueBoolean`) instead of a single `TEXT` column — a naive single-column
EAV can't do an indexed numeric range query at all (everything needs a cast
at query time). With typed columns:

- `(customFieldId, valueText)` — a composite B-Tree — serves equality
  lookups (`brand = 'Toyota'`).
- `(customFieldId, valueNumber)` — a composite B-Tree — serves **both**
  equality **and range** (`year >= 2020`). This is the headline EAV-vs-JSONB
  finding: B-Tree range queries are a first-class capability here, where the
  JSONB `jsonb_ops` GIN index couldn't support ranges even in principle.

Crucially, Prisma's native to-many relation filter —
`fieldValues: { some: { customFieldId, valueText: 'Toyota' } } }` — compiles
to an `EXISTS` subquery against `listing_field_values` that **can** use
these indexes directly. There's no `#>>`-vs-`@>` operator mismatch here the
way there was for JSONB: what Prisma generates and what the index expects
line up. The one limitation that carries over unchanged is full-text search
— Prisma's `search` filter is still the unindexable 1-argument
`to_tsvector(column)` form regardless of which structure the surrounding
predicate uses (see above) — `src/eav-search-analysis.ts` isolates this by
running the same combined scenario with FTS swapped for the indexed
`search_vector` column, to show the EAV half needs no such swap.

## 1. Start Postgres + the Node service

```bash
npm run docker:up
npm run docker:status   # wait for postgres healthcheck to pass
```

## 2. Generate the Prisma client, apply migrations, seed both structures

```bash
npm run docker:setup
```

This runs, in order: `prisma generate` → `prisma migrate deploy` → seed
JSONB (100,000 listings) → seed EAV (100,000 listings + field-value rows).
Expect a few minutes total. Each step can also be run individually — see
`package.json` for the underlying `docker:generate` / `docker:migrate` /
`docker:seed` / `docker:eav-seed` scripts.

## 3. Run the analysis — one command per structure

```bash
npm run docker:search-analysis       # JSONB
npm run docker:eav-search-analysis   # EAV
```

Each prints **one table, 7 rows** (so the two are directly comparable
side by side), then several `EXPLAIN (ANALYZE, BUFFERS)` plans:

1. **Subcategory filter** — `where: { subCategoryId }`
2. **Exact match** — `categoryId = 'Motors'` AND brand = `'Toyota'`
   (JSONB: `customData.path(['brand']).equals('Toyota')` · EAV: `fieldValues.some({ customFieldId, valueText: 'Toyota' })`)
3. **Range** — `categoryId = 'Motors'` AND year ≥ 2020
   (JSONB: `customData.path(['year']).gte(2020)` · EAV: `fieldValues.some({ customFieldId, valueNumber: { gte: 2020 } })`)
4. **Combined FTS + attribute** — `search: 'Silver'` (title/description) AND `categoryId = 'Motors'` AND brand = `'Toyota'`, all via Prisma
5. **Same complex search, without FTS** — row 4's filter, but the text match is `contains`/ILIKE instead of `search`
6. **Same complex search, with FTS (unindexed)** — identical query to row 4, kept as its own row for the "3 implementations" comparison
7. **Same complex search, with FTS (raw SQL, indexed)** — the properly-indexed version, via `$queryRaw`

Each row runs 1 untimed warm-up + 5 timed `findMany` calls (averaged),
and a plain `EXPLAIN` reports which index(es) the planner actually chose.

### Real output — JSONB (`npm run docker:search-analysis`)

```
Dataset size: 100,000 listings
##########################################################################################
SEARCH ANALYSIS SUMMARY (7 scenarios)
##########################################################################################
┌──────────────────────────────────────────┬───────────────┬──────────────────┬──────────┬──────────────────────────────┐
│ Scenario                                  │ Avg Time (ms) │ Min / Max (ms)   │ Matches  │ Index(es) Used                │
├──────────────────────────────────────────┼───────────────┼──────────────────┼──────────┼──────────────────────────────┤
│ 1. Subcategory filter ("Sedans")          │ 29.60         │ 23.66 / 40.50    │ 6,629    │ listings_subCategoryId_idx    │
│ 2. JSON exact match (brand="Toyota")      │ 29.08         │ 27.51 / 31.38    │ 2,436    │ listings_categoryId_idx       │
│ 3. JSON range filter (year>=2020)         │ 65.59         │ 41.63 / 105.82   │ 5,774    │ listings_categoryId_idx       │
│ 4. Combined FTS + JSON + category         │ 143.35        │ 130.75 / 153.21  │ 375      │ listings_categoryId_idx       │
│ 5. Without FTS (ILIKE)                    │ 127.29        │ 112.92 / 142.99  │ 410      │ listings_categoryId_idx       │
│ 6. With FTS (Prisma `search`, unindexed)  │ 160.43        │ 148.86 / 171.02  │ 375      │ listings_categoryId_idx       │
│ 7. With FTS (raw SQL, indexed)            │ 4.03          │ 3.44 / 5.49      │ 375      │ listings_search_vector_idx,   │
│                                            │               │                  │          │ listings_customData_idx       │
└──────────────────────────────────────────┴───────────────┴──────────────────┴──────────┴──────────────────────────────┘
```

### Real output — EAV (`npm run docker:eav-search-analysis`)

```
Dataset size: 100,000 EAV listings
##########################################################################################
EAV SEARCH ANALYSIS SUMMARY (7 scenarios)
##########################################################################################
┌──────────────────────────────────────────┬───────────────┬──────────────────┬──────────┬──────────────────────────────┐
│ Scenario                                  │ Avg Time (ms) │ Min / Max (ms)   │ Matches  │ Index(es) Used                │
├──────────────────────────────────────────┼───────────────┼──────────────────┼──────────┼──────────────────────────────┤
│ 1. Subcategory filter ("Sedans")          │ 31.97         │ 28.01 / 38.14    │ 6,671    │ eav_listings_subCategoryId_.. │
│ 2. EAV exact match (brand="Toyota")       │ 30.69         │ 27.57 / 35.80    │ 2,510    │ listing_field_values_custom.. │
│ 3. EAV range filter (year>=2020)          │ 52.17         │ 45.28 / 57.30    │ 5,769    │ listing_field_values_custom.. │
│ 4. Combined FTS + EAV + category          │ 228.96        │ 208.44 / 257.32  │ 448      │ listing_field_values_custom.. │
│ 5. Without FTS (ILIKE)                    │ 28.64         │ 25.50 / 38.06    │ 480      │ listing_field_values_custom.. │
│ 6. With FTS (Prisma `search`, unindexed)  │ 215.85        │ 208.58 / 230.11  │ 448      │ listing_field_values_custom.. │
│ 7. With FTS (raw SQL, indexed)            │ 10.25         │ 9.19 / 10.94     │ 448      │ listing_field_values_custom.. │
└──────────────────────────────────────────┴───────────────┴──────────────────┴──────────┴──────────────────────────────┘
```

(Real numbers from an actual run — yours will vary with hardware and live
table statistics, but the *shape* of the result — which rows are indexed,
which aren't, and by roughly how much — should reproduce.)

### Reading the two tables together

- **Rows 2 & 3 (exact match / range):** JSONB's exact match (29ms) is
  already Seq-Scan-bound; EAV's (31ms) looks similar here because the
  `Nested Loop` join back to `eav_listings` has its own per-row cost — the
  *indexability* is real (`EXPLAIN ANALYZE` shows a clean `Bitmap Index
  Scan` on the composite index), but at this data volume it doesn't
  automatically translate into a bigger win than JSONB's unindexed scan.
  Don't read "EAV is indexable" as "EAV is always faster" — verify with
  the printed `EXPLAIN ANALYZE` plans, not just the summary table.
- **Rows 4 & 6 (combined FTS, via Prisma):** intentionally the *same*
  query, kept as two rows. Both land far higher than row 7 in both tables
  (143→160ms JSONB, 229→216ms EAV) — confirming the FTS limitation is
  identical regardless of storage strategy, because it's about the
  `search` filter's SQL shape, not about JSONB vs. EAV.
- **Row 7 (raw SQL, indexed):** the payoff. ~4ms (JSONB) / ~10ms (EAV) vs.
  ~150-230ms for the Prisma-native equivalent — a 15-35x difference for
  the identical logical search, purely from using an indexable query shape.
- **Row 5 (ILIKE) — JSONB vs EAV diverge sharply:** EAV's ILIKE row
  (28.64ms) is far faster than JSONB's (127.29ms), because EAV's `EXISTS`
  join narrows to ~2,500 candidate rows via its composite index *before*
  ILIKE ever runs, while JSONB's `#>>` brand check can't use any index, so
  ILIKE scans the full ~20,000-row category bucket. This is the one place
  storage strategy visibly changes an *unindexed* predicate's cost, via a
  side effect on selectivity rather than the ILIKE itself becoming indexed.

## Resetting

```bash
npm run docker:down:clean   # stop containers AND drop the pg_data volume (wipes all seeded data)
```

## Tearing down

```bash
npm run docker:down   # stop containers, keep the seeded data
```
