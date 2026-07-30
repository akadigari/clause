/**
 * The model list, kept apart from claude.ts on purpose.
 *
 * The Ask panel needs these names to draw its dropdown before anyone has
 * chosen to turn the optional model on. If it imported them from claude.ts,
 * the bundler would pull that file, and the Anthropic SDK behind it, into the
 * panel. Two constants in their own file keep the SDK genuinely unloaded until
 * someone asks for it.
 */

export const MODELS = [
  { id: "claude-opus-5", label: "Opus 5", note: "Best answers" },
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "Cheaper and faster" },
] as const;

export const DEFAULT_MODEL: string = MODELS[0].id;
