import { PrismaClient } from "@prisma/client";
import Table from "cli-table3";

export const RUNS = 5;

export interface BenchResult {
  label: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  matches: number;
  indexesUsed: string[];
}

export async function timeMs<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const start = process.hrtime.bigint();
  const result = await fn();
  const end = process.hrtime.bigint();
  return { ms: Number(end - start) / 1_000_000, result };
}

/** Runs `fn` RUNS times (plus one untimed warm-up) and averages the wall time. */
export async function runBenchmark(
  label: string,
  fn: () => Promise<unknown[]>,
  indexesUsed: string[]
): Promise<BenchResult> {
  await fn(); // warm-up, not counted

  const timings: number[] = [];
  let matches = 0;

  for (let i = 0; i < RUNS; i++) {
    const { ms, result } = await timeMs(fn);
    timings.push(ms);
    matches = result.length;
  }

  const avgMs = timings.reduce((a, b) => a + b, 0) / timings.length;
  return { label, avgMs, minMs: Math.min(...timings), maxMs: Math.max(...timings), matches, indexesUsed };
}

/** Runs a plain EXPLAIN (no ANALYZE) on raw SQL and extracts which index(es) the planner chose. */
export async function explainIndexes(prisma: PrismaClient, sql: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${sql}`);
  const planText = rows.map((r) => r["QUERY PLAN"]).join("\n");
  const matches = [...planText.matchAll(/(?:Index Scan|Index Only Scan|Bitmap Index Scan) (?:using|on) "?([\w]+)"?/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

export async function printExplainAnalyze(prisma: PrismaClient, title: string, sql: string) {
  console.log(`\n${"=".repeat(90)}`);
  console.log(title);
  console.log("=".repeat(90));
  console.log(`SQL:\n${sql}\n`);
  const rows = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`);
  for (const row of rows) console.log(row["QUERY PLAN"]);
}

export function printSummaryTable(results: BenchResult[]) {
  const table = new Table({
    head: ["Scenario", "Avg Time (ms)", "Min / Max (ms)", "Matches", "Index(es) Used"],
    style: { head: ["cyan"] },
    wordWrap: true,
    colWidths: [42, 15, 18, 10, 30],
  });

  for (const r of results) {
    table.push([
      r.label,
      r.avgMs.toFixed(2),
      `${r.minMs.toFixed(2)} / ${r.maxMs.toFixed(2)}`,
      r.matches.toLocaleString(),
      r.indexesUsed.length > 0 ? r.indexesUsed.join(", ") : "None (Seq Scan)",
    ]);
  }

  console.log(table.toString());
}
