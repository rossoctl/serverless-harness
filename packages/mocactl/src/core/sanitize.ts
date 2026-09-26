import { stripVTControlCharacters } from 'node:util';

// C0 controls except \t (0x09) and \n (0x0a), DEL, and the C1 range (0x80-0x9f, which includes
// the 8-bit CSI 0x9b and OSC 0x9d).
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Makes a server-originated string safe to write to the user's terminal: strips every ANSI/VT
 * sequence (OSC 52 clipboard writes, OSC 0/2 window titles, OSC 8 links, SGR such as 8 "hidden")
 * and then any control character left over, so a sequence split across two stream deltas cannot
 * reassemble either. `\n` and `\t` survive; the theme's own colouring is applied afterwards.
 *
 * It lives in core/ (not render/) because describeError, which every error message goes through
 * headless and in the TUI alike, is in core/ and must not import render/.
 */
export function sanitizeRemote(s: string): string {
  return stripVTControlCharacters(s).replace(CONTROLS, '');
}
