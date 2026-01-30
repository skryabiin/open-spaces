import { CodespaceState } from './types';

/**
 * States indicating the codespace is transitioning and should be polled.
 */
export const TRANSITIONAL_STATES: CodespaceState[] = [
  'Starting',
  'ShuttingDown',
  'Provisioning',
  'Rebuilding',
  'Exporting',
  'Updating',
];

/**
 * Checks if a codespace state is transitional (in progress).
 */
export function isTransitionalState(state: CodespaceState): boolean {
  return TRANSITIONAL_STATES.includes(state);
}
