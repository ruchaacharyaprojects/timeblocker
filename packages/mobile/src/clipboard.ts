/**
 * Copy text to the system clipboard (R34.6).
 *
 * React Native 0.88 still ships `Clipboard` in core (deprecated, warns once),
 * so no extra native module is needed. Returns `false` if the platform call
 * fails; callers keep the text selectable on screen as the fallback.
 */
import { Clipboard } from 'react-native';

export function copyText(text: string): boolean {
  try {
    Clipboard.setString(text);
    return true;
  } catch {
    return false;
  }
}
