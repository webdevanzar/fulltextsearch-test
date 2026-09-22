# Full-Text Search with Prisma + PostgreSQL — Complete Setup Guide

A practical, copy-pasteable reference for adding PostgreSQL full-text search (FTS) to a
Prisma project — covering the core mechanism, JSONB and EAV dynamic-field variants,
ranking, typo tolerance, autocomplete, and the gotchas that aren't obvious until you hit them.

This guide assumes PostgreSQL 12+ (for generated columns) and Prisma 5/6.

---

## 1. Core vocabulary

| Term | What it is |
|---|---|
| `tsvector` | A normalized, searchable document: sorted lexemes (stemmed word-roots) + their positions. |
| `tsquery` | A parsed search expression (boolean tree of lexemes: `&` AND, `\|` OR, `!` NOT, `<->` followed-by). |
| **config** (e.g. `'english'`) | Defines the parser + dictionary chain used to build both the vector and the query. Must match on both sides or matches silently fail. |
| **parser** | Splits raw text into typed tokens (word, number, email, URL, hyphenated-word, ...). |
| **dictionary chain** | Per token type: for `english`, stopword removal then Snowball stemming (`running`→`run`). |
| `@@` | The match operator: `tsvector @@ tsquery → boolean`. |
| **GIN index** | Inverted index on a tsvector — stores `lexeme → list of rows` instead of `row → list of lexemes`, making word lookups fast. |

Run this anytime to see exactly how a string gets tokenized:
```sql
SELECT ts_debug('english', 'Running Silver Sedans');
```

---

## 2. Enable the Prisma preview feature

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["fullTextSearchPostgres"]
}
```

**What this actually does:** adds a `search?: string` option to generated `StringFilter`
types (`{ title: { search: "..." } }`) — nothing more. It does **not** create any column,
index, or DDL. Prisma has no native `tsvector` type, so the storage/indexing side below is
always hand-written raw SQL in a migration.

> ⚠️ **Prisma's own `search` filter is never index-backed on Postgres.** It generates
> `to_tsvector(column) @@ to_tsquery($1)` — the 1-argument form, with no explicit language.
> That form is classified `STABLE` (depends on the runtime `default_text_search_config`
> setting), and Postgres refuses to index `STABLE` expressions at all. This isn't a missing
> index — it's structurally impossible. **Always query FTS via raw SQL / `$queryRaw`**,
> never Prisma's `.search` filter, if you want it indexed.

---

## 3. The core pattern: a generated column + GIN index

This is the "set it up once, stays correct forever" mechanism — Postgres recomputes it
synchronously on every `INSERT`/`UPDATE`, so it can never drift out of sync with the source text.

```sql
ALTER TABLE "listings"
    ADD COLUMN "search_vector" tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
    ) STORED;

CREATE INDEX "listings_search_vector_idx" ON "listings" USING GIN ("search_vector");
```

**Key rule:** a generated column can only reference *other columns in the same row* — no
joins, no subqueries, no other tables. This single rule shapes everything in sections 5–6.

### Migration workflow (Prisma won't auto-generate this)

`prisma migrate dev` diffs your `schema.prisma` model fields against migration history.
Since generated columns have no `schema.prisma` syntax, it never produces this SQL on its
own — you always add it by hand:

```bash
npx prisma migrate dev --name add_search_vector --create-only   # scaffolds an empty .sql file, doesn't apply it
# → open the generated migration.sql and paste the ALTER TABLE + CREATE INDEX above
npx prisma migrate dev                                          # now apply it
# production:
npx prisma migrate deploy                                       # just replays migration files in order — safe, no diffing
```

`migrate deploy` never diffs/resets, so hand-written SQL baked into a migration file is
completely safe in production. The risk only exists with `migrate dev`'s drift detection —
which is fine as long as the SQL lives in a migration file (not run ad hoc against the DB).

### Optional: make Prisma aware of the column

```prisma
model Listing {
  // ...
  searchVector Unsupported("tsvector")?
}
```
Lets `prisma db pull` / introspection see the column (read-only) without Prisma trying to manage it.

---

## 4. Dynamic custom fields — JSONB variant

If you store admin-defined attributes as JSONB (`customData Json`), fold the whole blob's
text into the same generated expression — it's still the *same row*, so this is allowed:

```sql
GENERATED ALWAYS AS (
    to_tsvector('english',
        coalesce(title, '') || ' ' ||
        coalesce(description, '') || ' ' ||
        coalesce("customData"::text, '')
    )
) STORED
```

Because it's a blunt `::text` cast, every current *and future* admin-added key is
automatically searchable — no code changes needed when a new custom field type is added.
Tradeoff: JSON keys get tokenized too (usually harmless), and the vector/index grow with
every field you store.

---

## 5. Dynamic custom fields — EAV variant

If attributes live in a separate table (`listing_field_values`, one row per
listing+field), you **cannot** reach them from a generated column on the parent table —
different table, violates the same-row rule.

**❌ Don't do this** (requires a trigger, more moving parts, write-amplification):
```sql
-- trigger-maintained plain column that UPDATEs eav_listings whenever
-- listing_field_values changes — works, but adds real complexity
```

**✅ Do this instead** — give the *child* table its own generated column. Each
`listing_field_values` row only needs its own columns, so the same-row rule is satisfied:

```sql
ALTER TABLE listing_field_values
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce("valueText", '') || ' ' ||
      coalesce("valueNumber"::text, '') || ' ' ||
      coalesce("valueBoolean"::text, '')
    )
  ) STORED;

CREATE INDEX listing_field_values_search_vector_idx ON listing_field_values USING GIN (search_vector);
```

Zero triggers. Query by combining both indexed vectors at read time:

```sql
SELECT l.id, l.title
FROM eav_listings l
WHERE l.search_vector @@ websearch_to_tsquery('english', $1)
   OR EXISTS (
     SELECT 1 FROM listing_field_values lfv
     WHERE lfv."listingId" = l.id
       AND lfv.search_vector @@ websearch_to_tsquery('english', $1)
   );
```

Both branches use a real GIN index — this is the same `EXISTS` shape Prisma's own
`fieldValues: { some: {...} } }` relation filter compiles to, so it fits naturally
alongside your other EAV queries.

---

## 6. Building the search query (tsquery)

| Function | Behavior | When to use |
|---|---|---|
| `to_tsquery(config, text)` | Raw operator syntax (`'a & b'`). **Throws on malformed input.** | Internal/programmatic queries only — never raw user input. |
| `plainto_tsquery(config, text)` | ANDs every word, ignores any operators typed by the user. | Simple "match all these words" search. |
| `phraseto_tsquery(config, text)` | Words must appear in that order (like a quoted phrase). | Exact phrase matching. |
| `websearch_to_tsquery(config, text)` | Google-style: `"phrase"`, `-exclude`, `word1 or word2`. **Never throws.** | **Default choice for any user-facing search box.** |

Operators inside `to_tsquery`:

| Operator | Meaning | Example |
|---|---|---|
| `&` | AND | `'silver & sedan'` |
| `\|` | OR | `'silver \| gray'` |
| `!` | NOT | `'sedan & !diesel'` |
| `<->` | followed by (phrase) | `'toyota <-> corolla'` |
| `<N>` | within N words | `'silver <3> sedan'` |
| `:*` | prefix match (autocomplete) | `'run:*'` matches running/runs/run |

### Querying from Prisma — always raw SQL for the indexed path

```ts
await prisma.$queryRaw`
  SELECT id, title
  FROM listings
  WHERE search_vector @@ websearch_to_tsquery('english', ${userSearchTerm})
  LIMIT 20
`;
```

Using tagged-template `$queryRaw` (not `$queryRawUnsafe` with string concatenation)
parameterizes `${userSearchTerm}` safely — never string-interpolate raw user input into SQL text.

---

## 7. Ranking results by relevance

Plain `@@` only filters — it doesn't order by "how good" a match is. Add `ts_rank`, and
optionally `setweight()` to make some fields matter more than others:

```sql
-- schema: weight title higher than description
GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
) STORED
```

```sql
-- query: order by relevance
SELECT id, title, ts_rank(search_vector, q) AS rank
FROM listings, websearch_to_tsquery('english', $1) q
WHERE search_vector @@ q
ORDER BY rank DESC
LIMIT 20;
```

`ts_rank_cd` is a variant that also rewards matched terms appearing close together —
better for multi-word queries.

**Combining rank across two separate vectors** (EAV pattern from §5):
```sql
SELECT l.id, l.title,
  GREATEST(
    ts_rank(l.search_vector, q),
    COALESCE((SELECT MAX(ts_rank(lfv.search_vector, q)) FROM listing_field_values lfv WHERE lfv."listingId" = l.id), 0)
  ) AS rank
FROM eav_listings l, websearch_to_tsquery('english', $1) q
WHERE l.search_vector @@ q OR EXISTS (SELECT 1 FROM listing_field_values lfv WHERE lfv."listingId" = l.id AND lfv.search_vector @@ q)
ORDER BY rank DESC;
```

---

## 8. Highlighting matches

```sql
SELECT id, ts_headline('english', description, websearch_to_tsquery('english', $1)) AS snippet
FROM listings
WHERE search_vector @@ websearch_to_tsquery('english', $1)
LIMIT 20;
```

Wraps matches in `<b>...</b>` by default (configurable). Computed from the **raw text** at
query time, not the stored vector — fine for a page of results, not for scanning the whole table.

---

## 9. Typo tolerance (FTS alone does NOT do this)

Stemming ≠ spell-correction. `"toyata"` (misspelled) will **not** match `"toyota"` via `@@`.
For fuzzy matching, add the `pg_trgm` extension as a complement, not a replacement.

### Enabling the extension

**Option A — Prisma-native** (recommended). Extensions are one of the few pieces of this
whole FTS story that Prisma *does* have first-class schema support for:

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["fullTextSearchPostgres", "postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [pg_trgm]
}
```
```bash
npx prisma migrate dev --name add_pg_trgm
```
This generates `CREATE EXTENSION IF NOT EXISTS "pg_trgm";` automatically — no hand-editing needed.

**Option B — raw SQL**, consistent with how `search_vector` was added:
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Either way, `CREATE EXTENSION` needs the CREATE privilege on the database (the Docker
Postgres user here already has it since it owns the database) — on managed cloud Postgres,
confirm `pg_trgm` is pre-approved for non-superusers before relying on this.

### The index — always raw SQL, regardless of how the extension was enabled

Prisma's `@@index([field], type: Gin)` has no way to specify an **operator class**, and a
plain `text` column has no default GIN opclass — trigram search needs `gin_trgm_ops`
explicitly. So the index itself is always hand-written, even with Option A:

```bash
npx prisma migrate dev --name add_title_trgm_idx --create-only
```
```sql
CREATE INDEX listings_title_trgm_idx ON listings USING GIN (title gin_trgm_ops);
```
```bash
npx prisma migrate dev
```

**GIN vs GiST opclass** — matters for what gets accelerated:
- `gin_trgm_ops` — best for `%`/`ILIKE` **filtering**. What's used above.
- `gist_trgm_ops` — additionally makes `ORDER BY title <-> 'query' LIMIT n` **index-accelerated**
  nearest-neighbor search (KNN-GiST) — the right choice for a "closest single match" /
  "did you mean: Corolla?" style suggestion feature. GIN doesn't accelerate that ordering the same way.

### The full function/operator surface

`similarity()` is only one piece. The complete toolkit:

| Function | Returns | What it does |
|---|---|---|
| `similarity(text, text)` | `real` (0–1) | Trigram overlap between two **whole strings**. Penalized by length mismatch. |
| `word_similarity(text, text)` | `real` (0–1) | Similarity between the first string and the **best-matching substring** of the second — not penalized by the second string being longer. |
| `strict_word_similarity(text, text)` | `real` (0–1) | Same as `word_similarity`, but the match must land on word boundaries. |
| `show_trgm(text)` | `text[]` | Debugging: shows the actual 3-character trigrams generated for a string. |
| `similarity_dist(text, text)` | `real` | Same value as the `<->` operator, as a plain function. |

| Operator | Meaning | Threshold GUC |
|---|---|---|
| `%` | "similar enough" (whole-string) | `pg_trgm.similarity_threshold` (default `0.3`) |
| `<->` | distance (`1 - similarity`), for `ORDER BY ... <-> ...` ranking | — |
| `<%` | "similar enough" via `word_similarity` (substring-aware) | `pg_trgm.word_similarity_threshold` (default `0.6`) |
| `<<%` | same as `<%` but strict (word-boundary aware) | `pg_trgm.strict_word_similarity_threshold` |

### Which to actually use

For a short search term against a longer field (`"corolla"` vs. `"2020 Toyota Corolla
Silver Sedan"`), prefer `word_similarity`/`<%` over plain `similarity()`/`%` — whole-string
similarity penalizes the short query just for the length gap, even on a perfect substring match:

```sql
SELECT id, title, word_similarity('corola', title) AS score
FROM listings
WHERE 'corola' <% title
ORDER BY score DESC
LIMIT 20;
```

Plain `similarity()`/`%` (the earlier example) is more appropriate when both sides are
similarly short — e.g. comparing two titles to each other.

### Bonus: it also accelerates plain `ILIKE`

Once a trigram index exists, Postgres's planner automatically uses it for
`LIKE`/`ILIKE`/`~` (regex) queries on that column too — **no explicit operator needed, no
code change**. This is the fix for the `ILIKE '%Silver%'` full-scan scenario from earlier
benchmarks:
```sql
EXPLAIN ANALYZE SELECT id FROM listings WHERE title ILIKE '%Silver%';
-- now shows "Bitmap Index Scan on listings_title_trgm_idx" instead of "Seq Scan"
```

### Production pattern: FTS first, trigram as fallback

```ts
let results = await prisma.$queryRaw`
  SELECT id, title FROM listings
  WHERE search_vector @@ websearch_to_tsquery('english', ${term}) LIMIT 20
`;

if ((results as any[]).length === 0) {
  results = await prisma.$queryRaw`
    SELECT id, title FROM listings
    WHERE title % ${term} ORDER BY similarity(title, ${term}) DESC LIMIT 20
  `;
}
```
Exact/stemmed matching as the fast path, typo-tolerant fallback only when the strict search
comes up empty.

---

## 10. Prefix search / autocomplete

```sql
SELECT id, title FROM listings
WHERE search_vector @@ to_tsquery('english', $1 || ':*');
```
`to_tsquery('run:*')` matches any word starting with "run" — `running`, `runs`, `run`. Useful
for type-ahead search boxes where the user hasn't finished typing yet.

---

## 11. Checking what it's costing you

```sql
-- table + index sizes
SELECT
  pg_size_pretty(pg_total_relation_size('listings')) AS table_total,
  pg_size_pretty(pg_relation_size('listings')) AS heap_only,
  pg_size_pretty(pg_relation_size('listings_search_vector_idx')) AS fts_gin_index;

-- what words are actually stored (find noisy/junk tokens worth excluding)
SELECT * FROM ts_stat('SELECT search_vector FROM listings') ORDER BY nentry DESC LIMIT 20;

-- confirm the index is actually being used
EXPLAIN ANALYZE
SELECT id FROM listings WHERE search_vector @@ websearch_to_tsquery('english', 'silver sedan');
-- look for "Bitmap Index Scan on listings_search_vector_idx", not "Seq Scan"
```

GIN indexes are the expensive part of this whole setup, not the column — for context, in
this project's own 100k-row benchmark, the FTS GIN index alone was **~41 MB**, roughly 28%
of the table's own heap size, just for two short text fields. Budget for that on large tables.

---

## 12. Gotchas checklist

- ❌ **Never** query via Prisma's native `.search` filter if you want an index used — it's
  structurally unindexed on Postgres (§3). Always raw SQL against the generated column.
- ❌ **Never** pass raw user input to `to_tsquery` directly — it throws on malformed syntax.
  Use `websearch_to_tsquery` for anything user-facing.
- ❌ A generated column **cannot** reference another table — route around this by giving
  the *child* table its own generated column (§5), not a trigger, when possible.
- ❌ Query-side config must match document-side config (`'english'` vs `'english'`) or
  matches silently fail — no error, just empty results.
- ❌ An all-stopword query (`"the of a"`) produces an empty tsquery that matches nothing —
  handle this explicitly in the app layer rather than showing a confusing "0 results."
- ❌ FTS handles stemming, not typos — pair with `pg_trgm` (§9) if typo tolerance matters.
- ❌ Multi-language content needs more than one config — either a `regconfig` column per
  row, separate vectors per language, or fall back to the `'simple'` config.
- ⚠️ Two `node_modules` in a Dockerized project (host + container) means `prisma generate`
  must be run in **both** places after any schema change, or your IDE shows stale/incorrect
  types even though the container works fine.

---

## 13. Quick command reference

```bash
# Local dev
npx prisma generate                                    # regenerate client (run on host AND in container)
npx prisma migrate dev --name <name> --create-only      # scaffold empty migration for hand-written SQL
npx prisma migrate dev                                  # apply pending migrations locally
npx prisma migrate deploy                                # apply pending migrations in production (no diffing)

# Inside psql (or `docker compose exec postgres psql -U <user> -d <db>`)
SELECT ts_debug('english', 'text to inspect');           # see exact tokenization
SELECT ts_stat('SELECT search_vector FROM listings');     # lexeme frequency table
EXPLAIN ANALYZE SELECT ...;                               # confirm index usage
\d listings                                               # inspect columns/indexes
```
