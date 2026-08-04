/**
 * The two sentences the edit panel has to put in front of anyone using it.
 *
 * These live in their own file, apart from `edit.ts`, for one reason: the panel
 * shows them before anybody clicks anything, so they have to be there the
 * moment the panel renders. `edit.ts` pulls in pdf-lib and the content stream
 * cutter, which is most of a megabyte, and the panel loads that lazily on the
 * first apply. Importing the strings from `edit.ts` dragged all of it into the
 * panel's own chunk and quietly undid the lazy load. Strings have no
 * dependencies, so they can be free.
 *
 * They stay out of the panel itself so there is one wording, so it cannot drift
 * away from what the code actually does, and so a test can hold it to the same
 * promise the module header makes. `edit.ts` re-exports both, so anything
 * already importing them from there keeps working.
 */

/**
 * What to say when a run could only be painted over.
 *
 * A user who changes a salary figure and is not told this will believe the old
 * number is gone. It is not gone.
 */
export const COVER_NOT_REMOVED =
  "Some of these could only be painted over. For those runs the old text is still inside the file and can still be searched, copied and extracted. To take words out of a document for certain, use Redact.";

/**
 * What to say when every run really was cut out.
 *
 * This one is allowed to say the words are gone, because in this case they are,
 * and the cut proved it by reading the file back before returning. Only show it
 * when `covered` is zero.
 */
export const OLD_TEXT_REMOVED =
  "The old words were taken out of the file, not just covered up, so they cannot be searched or copied out any more.";
