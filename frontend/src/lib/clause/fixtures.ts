/** Test support: the same fixture documents and scripted answerer the Python
 * test suite uses. Kept out of the .test.ts files so ask, scan, and store all
 * assert against one identical lease.
 *
 * Nothing in the app imports this.
 */

import { HashingEmbedder } from "./embedding";
import { DocumentStore } from "./store";
import type { Answer, Answerer, Category, Excerpt, FlagFinding } from "./types";

// One page per clause so retrieval assertions can check page numbers.
export const LEASE_PAGES = [
  "Section 3. Rent. Monthly rent is $1,850 due on the first day of each " +
    "month. If rent is not received by the fifth day, the tenant pays a late " +
    "fee of $75 plus $10 per additional day, capped at $250 per month.",
  "Section 7. Pets. No pets are permitted without prior written consent. " +
    "An approved pet requires a one-time fee of $300 and pet rent of $40 per " +
    "month.",
  "Section 12. Early Termination. Ending the lease early requires sixty " +
    "days written notice and an early termination fee equal to two months " +
    "of rent.",
];

export const MANUAL_PAGES = [
  "Blender Care. Wash the pitcher by hand with warm soapy water. The " +
    "blade assembly is not dishwasher safe.",
  "Warranty. The blender motor is covered for five years from the date of " +
    "purchase. Register the product online to activate coverage.",
];

export const BENIGN_PAGES = [
  "The sky is blue on a clear day. Water is wet. Birds tend to sing at " +
    "dawn, and the grass turns green after rain.",
];

export function makeStore(): DocumentStore {
  return new DocumentStore(new HashingEmbedder());
}

/** Scripted stand-in for a real model. Records every call so tests can prove
 * the model was never consulted when a gate should have stopped first. */
export class FakeAnswerer implements Answerer {
  readonly result: Answer;
  readonly flags: FlagFinding[];
  readonly calls: Array<[string, Excerpt[]]> = [];
  readonly flagCalls: Array<[Excerpt[], Category[]]> = [];

  constructor(result?: Answer | null, flags?: FlagFinding[]) {
    this.result = result ?? { found: true, answer: "stub", citations: [0] };
    this.flags = flags ?? [];
  }

  async answer(question: string, excerpts: Excerpt[]): Promise<Answer> {
    this.calls.push([question, excerpts]);
    return this.result;
  }

  async findFlags(
    excerpts: Excerpt[],
    categories: Category[],
  ): Promise<FlagFinding[]> {
    this.flagCalls.push([excerpts, categories]);
    return this.flags;
  }
}
