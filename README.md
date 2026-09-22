# Prisma FTS + JSONB + EAV + Relational Filtering Benchmark

A Dockerized testbed analyzing the computational complexity of combined
**category/subcategory (relational)**, **dynamic custom-field filtering**,
and **full-text search** with Prisma against PostgreSQL 15 — comparing two
completely independent storage strategies for the dynamic custom fields:
**JSONB** vs. **EAV (Entity-Attribute-Value)**.

## What's in here

```
docker-compose.yml               Postgres 15 + Node service
Dockerfile                       Node 20 image for the benchmark service
prisma/schema.prisma             Both table sets (see below)
prisma/migrations/0_init/               JSONB structure: Category/SubCategory/Listing
prisma/migrations/1_eav_custom_fields/  EAV structure: EavCategory/.../CustomField/ListingFieldValue
src/lib/listing-content.ts       Shared listing generator (used by both seed scripts, for apples-to-apples data)
src/lib/bench.ts                 Shared benchmarking/EXPLAIN harness (used by both benchmark scripts)
src/seed.ts                      Seeds the JSONB structure — 100,000 listings
src/eav-seed.ts                  Seeds the EAV structure — 100,000 listings + field-value rows
src/benchmark.ts                 JSONB benchmark — 4 scenarios + EXPLAIN ANALYZE
src/eav-benchmark.ts             EAV benchmark — the same 4 scenarios + EXPLAIN ANALYZE
src/complex-search.ts            One complex search, 3 implementations (ILIKE / unindexed FTS / indexed FTS) side by side
```

## Two independent structures — no shared tables

This project seeds and benchmarks **two completely separate table sets**
for the same kind of data, so they can be compared head-to-head with zero
cross-contamination:

| | JSONB structure | EAV structure |
|---|---|---|
| Tables | `categories`, `sub_categories`, `listings` | `eav_categories`, `eav_sub_categories`, `eav_listings`, `custom_fields`, `sub_category_fields`, `listing_field_values` |
| Custom attributes | `listings.customData` (JSONB blob) | rows in `listing_field_values`, one per (listing, field) |
| Seed command | `npm run docker:seed` | `npm run docker:eav-seed` |
| Benchmark command | `npm run docker:benchmark` | `npm run docker:eav-benchmark` |

Both use `src/lib/listing-content.ts` to generate listings, so the two
datasets are **statistically equivalent** (same brand/color distributions,
same "Toyota"/"Silver" weighting) even though nothing is literally shared —
that's what makes timing numbers between the two comparable.

## Schema

- **Category** (`Motors`, `Real Estate`, `Gadgets`, `Furniture`, `Fashion`) — 5 rows.
- **SubCategory** — 3 per category, 15 rows total (e.g. Motors → Sedans/SUVs/Motorcycles).
- **Listing** — 100,000 rows, each belonging to one category + one subcategory, with a
  `customData` JSONB column whose shape depends on the category:
  - Motors: `{"brand": "Toyota", "year": 2021, "mileage": 45000}`
  - Real Estate: `{"bedrooms": 3, "bathrooms": 2, "sqft": 1500, "furnished": true}`
  - Gadgets: `{"brand": "Apple", "ram": "16GB", "storage": "512GB"}`
  - Furniture: `{"material": "Oak", "color": "Brown", "assemblyRequired": true}`
  - Fashion: `{"size": "M", "color": "Black", "material": "Cotton"}`

  Motors listings deliberately mix "Toyota" and "Silver" at meaningful,
  independently-tunable rates (`src/seed.ts`) so the benchmark's combined
  FTS + JSON scenario returns a non-trivial result set.

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

So scenarios 2 and 3 below, run through Prisma's own JSON filter API, will
generally **not** use the `customData` GIN index — only the B-Tree on
`categoryId` is available to them. This is printed and labeled explicitly
in the benchmark output and is the headline "computational complexity"
finding, not noise to explain away.

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
section) — not via Prisma's ORM-level `search` filter.

| Index | Type | Backs |
|---|---|---|
| `listings_categoryId_idx` | B-Tree | `categoryId` filters (all scenarios) |
| `listings_subCategoryId_idx` | B-Tree | scenario 1 |
| `listings_customData_idx` | GIN (`jsonb_ops`) | only raw `@>` containment queries — **not** Prisma's `path`/`equals`/`gte` filters |
| `listings_search_vector_idx` | GIN | only the raw "ideal indexed plan" EXPLAIN ANALYZE demo — **not** reachable through Prisma's `search` filter |

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
predicate uses (see above) — `src/eav-benchmark.ts` isolates this by running
the same combined scenario with FTS swapped for the indexed `search_vector`
column, to show the EAV half needs no such swap.

## 1. Start Postgres + the Node service

```bash
docker compose up -d --build
docker compose ps   # wait for postgres healthcheck to pass
```

## 2. Generate the Prisma client and apply the migration

```bash
docker compose exec node npx prisma generate
docker compose exec node npx prisma migrate deploy
```

> If you're re-running this against a volume seeded by an earlier version
> of this project (the FTS-only `ProductListing` model), wipe it first:
> `docker compose down -v`, then start again from step 1 — the schema
> changed and old migration state won't reconcile.

## 3. Seed — run both, they're fully independent

```bash
docker compose exec node npm run seed          # JSONB structure: 100,000 listings
docker compose exec node npm run eav-seed       # EAV structure: 100,000 listings + field-value rows
```

Or via the wrapper scripts from your host terminal:

```bash
npm run docker:seed
npm run docker:eav-seed
```

Each seeds its own 5 categories / 15 subcategories / 100,000 listings in
batches of 2,000 via `createMany`. `eav-seed` additionally seeds 16
`custom_fields` rows and ~50 `sub_category_fields` associations first, then
one `listing_field_values` row per (listing, applicable field) — expect
somewhat longer than `seed` (more rows written overall). Either can be
re-run independently at any time; each truncates and reseeds only its own
tables.

## 4. Run the benchmarks — two separate commands, one per structure

```bash
docker compose exec node npm run benchmark          # JSONB
docker compose exec node npm run eav-benchmark      # EAV
```

Or: `npm run docker:benchmark` / `npm run docker:eav-benchmark` from your
host terminal. Both run the **same 4 scenarios** (so their console output
is directly comparable side by side):

1. **Subcategory filter** — `where: { subCategoryId }`
2. **Exact match** — `categoryId = 'Motors'` AND brand = `'Toyota'`
   (JSONB: `customData.path(['brand']).equals('Toyota')` · EAV: `fieldValues.some({ customFieldId, valueText: 'Toyota' })`)
3. **Range** — `categoryId = 'Motors'` AND year ≥ 2020
   (JSONB: `customData.path(['year']).gte(2020)` · EAV: `fieldValues.some({ customFieldId, valueNumber: { gte: 2020 } })`)
4. **Combined FTS + custom field** — `search: 'Silver'` (title/description) AND `categoryId = 'Motors'` AND brand = `'Toyota'`

Each runs 1 untimed warm-up + 5 timed `findMany` calls (averaged), inspects
a plain `EXPLAIN` to report which index(es) the planner actually chose, then
prints a summary table.

```
Dataset size: 100,000 listings
Each scenario: 1 warm-up + 5 timed runs (averaged)

##########################################################################################
BENCHMARK SUMMARY
##########################################################################################
┌──────────────────────────────────────────┬───────────────┬──────────────────┬──────────┬────────────────────────────┐
│ Scenario                                  │ Avg Time (ms) │ Min / Max (ms)   │ Matches  │ Index(es) Used             │
├──────────────────────────────────────────┼───────────────┼──────────────────┼──────────┼────────────────────────────┤
│ Subcategory filter ("Sedans")             │ 5.10          │ 4.60 / 5.80      │ 6,690    │ listings_subCategoryId_idx │
│ JSON exact match (categoryId + brand=...) │ 38.20         │ 35.10 / 41.00    │ 2,480    │ listings_categoryId_idx    │
│ JSON range filter (categoryId + year>=..) │ 41.75         │ 38.90 / 45.30    │ 12,050   │ listings_categoryId_idx    │
│ Combined FTS + JSON + category            │ 27.40         │ 24.90 / 29.80    │ 410      │ listings_categoryId_idx    │
└──────────────────────────────────────────┴───────────────┴──────────────────┴──────────┴────────────────────────────┘
```

(Illustrative only — exact numbers and which indexes the planner picks
depend on your hardware, live table statistics, and seeded data
distribution.)

It then prints two full `EXPLAIN (ANALYZE, BUFFERS)` plans for the
combined FTS + JSON scenario, back to back, so you can compare them
directly:

1. **"Ideal indexed plan"** — the same logical filter written with `@>`
   JSONB containment instead of Prisma's `#>>` extraction. This is the
   query shape that lets Postgres combine all three index types (B-Tree
   on `categoryId`, GIN on `customData`, GIN on the FTS `tsvector`
   columns) into a single `BitmapAnd`/`BitmapOr` plan.
2. **"What Prisma actually generates"** — the literal `#>>` shape Prisma's
   `path`/`equals` filter produces, run through the same combined filter,
   for direct before/after comparison.

`eav-benchmark` prints the same shape of table, but expect the exact-match
and range rows to actually list `listing_field_values_customFieldId_...idx`
— because, unlike JSONB, Prisma's generated `EXISTS` query for the EAV
relation filter genuinely can use those composite indexes:

```
┌──────────────────────────────────────────┬───────────────┬──────────────────┬──────────┬───────────────────────────────────────────────┐
│ Scenario                                  │ Avg Time (ms) │ Min / Max (ms)   │ Matches  │ Index(es) Used                                 │
├──────────────────────────────────────────┼───────────────┼──────────────────┼──────────┼───────────────────────────────────────────────┤
│ Subcategory filter ("Sedans")             │ 5.30          │ 4.70 / 6.10      │ 6,712    │ eav_listings_subCategoryId_idx                 │
│ EAV exact match (categoryId + brand=...)  │ 4.10          │ 3.50 / 4.80      │ 2,519    │ listings_categoryId_idx (eav_listings),        │
│                                            │               │                  │          │ listing_field_values_customFieldId_valueText_idx│
│ EAV range filter (categoryId + year>=..)  │ 3.85          │ 3.20 / 4.50      │ 5,693    │ listing_field_values_customFieldId_valueNumber_idx│
│ Combined FTS + EAV + category             │ 26.90         │ 24.10 / 29.40    │ 413      │ eav_listings_categoryId_idx,                   │
│                                            │               │                  │          │ listing_field_values_customFieldId_valueText_idx│
└──────────────────────────────────────────┴───────────────┴──────────────────┴──────────┴───────────────────────────────────────────────┘
```

The range scenario in particular is the headline contrast: ~42ms/Seq-Scan
via JSONB vs. ~4ms/indexed via EAV, for the exact same logical filter — the
`(customFieldId, valueNumber)` B-Tree does what a `jsonb_ops` GIN index
structurally cannot. The combined FTS row stays slow in both, confirming
the FTS limitation is orthogonal to which storage strategy you pick.

## Resetting

```bash
docker compose down -v   # drops the pg_data volume, wiping all seeded data
```

## Tearing down

```bash
docker compose down
```
