#!/usr/bin/env node
/**
 * Daily/dispatch-oriented wrapper around verify-specs.mjs.
 *
 * The verification pipeline + structured report generation both live in
 * verify-specs.mjs. This wrapper only orchestrates output destinations:
 *
 *  - Always prints the shared report to stdout. Detailed analysis trailer
 *    is appended only when env `LOG_DETAIL_X_ADDED_IN_VERSION=true`.
 *  - Always writes the full report (with detail) to `REPORT_PATH` (defaults
 *    to `output/verify-report.md` next to this script).
 *  - Exits with code 1 when any error is found.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReport,
  hasAnyError,
  loadInputs,
  printCliReport,
  verifySpecs,
} from "./verify-specs.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const includeDetailInCli =
  String(process.env.LOG_DETAIL_X_ADDED_IN_VERSION ?? "").toLowerCase() === "true";

const inputs = loadInputs();
const result = verifySpecs(inputs);

// Shared CLI output (identical to standalone + CI wrappers).
printCliReport(result, inputs.versionMap, { includeDetail: includeDetailInCli });

// Persisted Markdown report always includes the detail trailer.
const reportPath = resolve(
  process.env.REPORT_PATH ?? join(scriptDir, "output", "verify-report.md")
);
const reportText = buildReport(result, inputs.versionMap, { includeDetail: true });
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, reportText + "\n");

console.log("");
console.log(`Report written to: ${reportPath}`);
process.exit(hasAnyError(result) ? 1 : 0);
