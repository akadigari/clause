/**
 * The optional model.
 *
 * Everything else in this app runs on your machine. This one file does not: if
 * you paste in your own Anthropic API key, the passages Clause retrieved are
 * sent to Anthropic so a model can write a plain-English answer about them.
 *
 * The rules that make that trade honest:
 *
 *  - It is off unless you turn it on, and it needs your own key.
 *  - The key is held in memory for this tab only. It is never written to
 *    storage, so closing the tab forgets it.
 *  - Only the retrieved excerpts go out, never the whole document.
 *  - The network meter turns amber and says "sending" while a call is in
 *    flight, so it is visible rather than quiet.
 *
 * The grounding rules live outside the model, in ask.ts and flags.ts: no
 * relevant passage means no call at all, and an answer whose citations do not
 * point at real excerpts is thrown away. This file only produces a candidate
 * answer, it does not get to decide whether the answer is trustworthy.
 *
 * The SDK is loaded on demand so people who never turn this on never download
 * it.
 */

import { countUpload } from "../net";
import type {
  Answer,
  Answerer,
  Category,
  Excerpt,
  FlagFinding,
} from "./types";

import { DEFAULT_MODEL } from "./models";

const MAX_ANSWER_TOKENS = 16000;

const SYSTEM_PROMPT = `You are Clause, an assistant that explains confusing documents \
(leases, contracts, terms of service, insurance policies, manuals) to ordinary \
people in plain English.

You will receive a question and a numbered list of excerpts from the user's \
document. The excerpts are the ONLY thing you know about this document.

Rules, in priority order:
1. Never invent or assume anything that is not stated in the excerpts. Do not \
use outside knowledge about laws, typical contracts, or common practices to \
fill gaps.
2. If the excerpts do not actually answer the question, set "found" to false. \
A topically related excerpt that doesn't answer the question is NOT an answer.
3. When you do answer, set "found" to true, and cite every excerpt you relied \
on by its number in "citations". Only list excerpts you actually used.
4. Write for a smart friend, not a lawyer: short sentences, everyday words, \
and concrete numbers/dates/amounts quoted from the document. Explain any \
unavoidable legal term in parentheses.
5. If the document's answer has an important catch or condition in the \
excerpts (deadlines, fees, exceptions), mention it, that's usually what the \
user really needs to know.
6. You explain what the document says; you do not give legal advice. Do not \
add disclaimers saying so, just stick to the document.

Respond with JSON: {"found": boolean, "answer": string, "citations": number[]}. \
When "found" is false, "answer" should briefly say the document excerpts don't \
cover it, and "citations" must be empty.`;

const SCAN_SYSTEM_PROMPT = `You are Clause, reviewing a document (lease, contract, \
terms of service, insurance policy, or manual) to point out clauses an ordinary \
person would want to notice before signing or agreeing to it.

You will receive a list of risk categories (each with an id) and a numbered \
list of excerpts from the user's document. The excerpts are the ONLY thing you \
know about this document.

Rules, in priority order:
1. Only flag something that is actually stated in the excerpts. Never infer, \
assume, or use outside knowledge about typical contracts or the law. If a \
category is not clearly present in the excerpts, do not flag it.
2. Every flag must cite the excerpt number(s) it is based on. No excerpt, no \
flag.
3. Use one of the provided category ids exactly. If an excerpt raises a \
concern that fits none of the categories, skip it.
4. severity: "high" for clauses that can cost real money or remove important \
rights (auto-renewal that keeps charging you, large penalties, giving up the \
right to sue); "medium" for meaningful costs or obligations; "low" for minor \
notes.
5. explanation: one or two short, plain-English sentences telling the reader \
what the clause means for THEM and why it is worth noticing. No legal jargon. \
Quote concrete numbers, dates, or amounts from the excerpt when they are there.
6. You point out what the document says; you do not give legal advice. Do not \
add disclaimers, just describe the clause plainly.
7. Returning an empty list is correct when nothing in the excerpts genuinely \
matches the categories. Never manufacture a flag to fill the list.

Respond with JSON: {"flags": [{"category": string, "severity": \
"high"|"medium"|"low", "explanation": string, "citations": number[]}]}.`;

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    answer: { type: "string" },
    citations: { type: "array", items: { type: "integer" } },
  },
  required: ["found", "answer", "citations"],
  additionalProperties: false,
} as const;

const FLAG_SCHEMA = {
  type: "object",
  properties: {
    flags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          explanation: { type: "string" },
          citations: { type: "array", items: { type: "integer" } },
        },
        required: ["category", "severity", "explanation", "citations"],
        additionalProperties: false,
      },
    },
  },
  required: ["flags"],
  additionalProperties: false,
} as const;

/** A failed call, phrased so the user can act on it. */
export class AnswererError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswererError";
  }
}

type SdkModule = typeof import("@anthropic-ai/sdk");

let sdkPromise: Promise<SdkModule> | null = null;

function sdk(): Promise<SdkModule> {
  if (!sdkPromise) sdkPromise = import("@anthropic-ai/sdk");
  return sdkPromise;
}

/**
 * The one thing in this app that talks to a server, and only with your key.
 */
export class ClaudeAnswerer implements Answerer {
  constructor(
    private readonly apiKey: string,
    readonly model: string = DEFAULT_MODEL,
  ) {}

  private async send(
    system: string,
    prompt: string,
    schema: Record<string, unknown>,
  ): Promise<string> {
    const { default: Anthropic } = await sdk();
    const client = new Anthropic({
      apiKey: this.apiKey,
      // The key belongs to the person typing it in and never leaves their
      // browser except as an auth header to Anthropic. There is no server here
      // to keep it on instead.
      dangerouslyAllowBrowser: true,
    });

    const done = countUpload(new TextEncoder().encode(prompt).length);
    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: MAX_ANSWER_TOKENS,
        system,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: prompt }],
      });

      // A refusal is a normal 200 with an empty or partial body, so this has
      // to be checked before reading content or the next line throws.
      if (response.stop_reason === "refusal") {
        throw new AnswererError(
          "Anthropic's safety checks declined this document. Clause still works without a key: it will show you the exact passages instead.",
        );
      }

      const text = response.content.find((block) => block.type === "text");
      if (!text || text.type !== "text") {
        throw new AnswererError("The model replied with nothing to read.");
      }
      return text.text;
    } catch (err) {
      throw asFriendlyError(err);
    } finally {
      done();
    }
  }

  async answer(question: string, excerpts: Excerpt[]): Promise<Answer> {
    const numbered = excerpts
      .map(([label, text], i) => `[Excerpt ${i}] (from ${label})\n${text}`)
      .join("\n\n");
    const prompt = `Document excerpts:\n\n${numbered}\n\nQuestion: ${question.trim()}`;
    const raw = await this.send(SYSTEM_PROMPT, prompt, ANSWER_SCHEMA);

    try {
      const data = JSON.parse(raw) as {
        found: boolean;
        answer: string;
        citations: number[];
      };
      return {
        found: Boolean(data.found),
        answer: String(data.answer ?? ""),
        citations: (data.citations ?? []).map((n) => Number(n)),
      };
    } catch {
      throw new AnswererError("The model's answer could not be read as JSON.");
    }
  }

  async findFlags(
    excerpts: Excerpt[],
    categories: Category[],
  ): Promise<FlagFinding[]> {
    const numbered = excerpts
      .map(([, text], i) => `[Excerpt ${i}]\n${text}`)
      .join("\n\n");
    const catList = categories.map(([id, hint]) => `- ${id}: ${hint}`).join("\n");
    const prompt = `Risk categories to look for:\n${catList}\n\nDocument excerpts:\n\n${numbered}`;
    const raw = await this.send(SCAN_SYSTEM_PROMPT, prompt, FLAG_SCHEMA);

    try {
      const data = JSON.parse(raw) as {
        flags: Array<{
          category: string;
          severity: string;
          explanation: string;
          citations: number[];
        }>;
      };
      return (data.flags ?? []).map((flag) => ({
        category: String(flag.category),
        severity: String(flag.severity),
        explanation: String(flag.explanation ?? ""),
        citations: (flag.citations ?? []).map((n) => Number(n)),
      }));
    } catch {
      throw new AnswererError("The model's scan could not be read as JSON.");
    }
  }
}

/**
 * Turn an SDK failure into a sentence that says what to do next.
 *
 * The SDK exports typed error classes, but importing them here would pull the
 * whole package into the main bundle just to run an instanceof check, which
 * defeats loading it on demand. The status code carries the same information.
 */
function asFriendlyError(err: unknown): AnswererError {
  if (err instanceof AnswererError) return err;

  const status = (err as { status?: number })?.status;
  switch (status) {
    case 401:
    case 403:
      return new AnswererError(
        "Anthropic rejected that API key. Check it was copied whole, including the sk-ant- prefix.",
      );
    case 429:
      return new AnswererError(
        "Anthropic is rate limiting your key. Wait a moment and ask again.",
      );
    case 400:
      return new AnswererError(
        "Anthropic rejected the request. This is a bug in Clause, not in your document.",
      );
    default:
      break;
  }
  if (status && status >= 500) {
    return new AnswererError("Anthropic's API is having trouble. Try again shortly.");
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new AnswererError(
    `Could not reach Anthropic. You may be offline, in which case everything else here still works. (${detail})`,
  );
}
