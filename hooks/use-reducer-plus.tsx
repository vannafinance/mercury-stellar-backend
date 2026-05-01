import { useReducer } from "react";

export function isObject(item: any) {
  return item && typeof item === "object" && !Array.isArray(item);
}

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