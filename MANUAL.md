# User Manual

## Overview

A Dockerized testbed comparing search/filter performance in PostgreSQL 15
under Prisma: **JSONB vs. EAV** storage for dynamic attributes (like
"brand", "year", "bedrooms"), plus how each behaves combined with
category filters and full-text search. Two independent datasets (100,000
rows each) are seeded and benchmarked separately, and each run prints a
table of timings plus real `EXPLAIN ANALYZE` query plans so you can see
*why* a query was fast or slow, not just how long it took.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running.

## How to run it

```bash
cd search-test

# 1. Start Postgres + the app container
npm run docker:up

# 2. Set up the database (client, migrations, both datasets — takes a few minutes)
npm run docker:setup

# 3. Run the analysis (prints two 7-row result tables + query plans)
npm run docker:search-analysis
npm run docker:eav-search-analysis
```

That's it. Steps 1–2 are one-time setup; re-run step 3 any time.

## What you'll see

Each analysis command prints a summary table (scenario, avg time, matches,
which index was used) followed by real Postgres execution plans. The
short version of the finding: **a missing/wrong index doesn't break a
query, it just makes Postgres scan instead of look up** — same results,
much slower, and the tables make that difference visible.

## Cleaning up

```bash
npm run docker:down          # stop containers, keep the seeded data
npm run docker:down:clean    # stop containers AND delete all data
```

## More detail

See `README.md` for the full write-up (schema, indexing internals, sample
output, why each scenario behaves the way it does).
