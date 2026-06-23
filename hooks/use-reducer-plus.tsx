// A `useReducer` variant whose dispatch accepts a partial patch and deep-merges
// it into state — convenient for nested form/object state where you want to
// update one leaf without spreading the whole tree by hand.

import { useReducer } from "react";

/** True for plain objects (non-null, non-array). Used to decide when to recurse during merge. */
export function isObject(item: any) {
  return item && typeof item === "object" && !Array.isArray(item);
}

/**
 * Recursively merges `sources` into `target`, mutating `target` in place and
 * returning it. Plain-object values are merged key-by-key; all other values
 * (including arrays) overwrite. Later sources win.
 */
export function deepmerge<T>(target: any, ...sources: any): T {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        deepmerge(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return deepmerge(target, ...sources);
}

type RecursivePartial<T> = {
  [P in keyof T]?: RecursivePartial<T[P]>;
};

/**
 * Like `useReducer`, but `dispatch` takes a `RecursivePartial<T>` patch that is
 * deep-merged into the current state instead of a discriminated action.
 *
 * @param initialStateObject - Initial state (defaults to `{}` if falsy).
 * @returns `[state, dispatch]` tuple; call `dispatch(partial)` to merge updates.
 */
export default function useReducerPlus<T extends object>(
  initialStateObject: T
) {
  const [state, dispatch] = useReducer(
    (state: T, update: RecursivePartial<T>) => {
      if (update) {
        deepmerge(state, update);
        return { ...state };
      }
      return state;
    },
    initialStateObject || {}
  );

  return [state, dispatch] as const;
}