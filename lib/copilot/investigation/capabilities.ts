/**
 * Investigator read surface. The catalogue in `catalog.ts` is the source of truth;
 * this module is the stable import path used by the runtime.
 *
 * Writes never appear here. Identity is bound in `resolveRead`, never taken from
 * model arguments.
 */
export { readCapabilities, resolveRead, catalogToolNames, catalogReadNames } from "./catalog";
