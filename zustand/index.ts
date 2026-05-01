import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

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

type Custom<S, T = any> = (state: S) => T;

type Actions<S> = {
  get<T>(fn: Custom<S, T>): T;
  set: (up: RecursivePartial<S>) => void;
  reset: () => void;
};

type Setter<S> = (fn: () => Partial<S>) => void;
type Getter<S> = () => StoreState<S>;

type Store<S> = (setState: Setter<S>, getState: Getter<S>) => StoreState<S>;

type StoreState<S> = S & Actions<S>;

const getActions = <S>(setState: Setter<S>, getState: Getter<S>, state: S) => ({
  get: <T>(fn: Custom<S, T>) => {
    return fn(getState());
  },

  set: (update: RecursivePartial<S>) => {
    const obj = { ...getState() } as any;
    deepmerge(obj, update);
    setState(() => obj);
  },

  reset: () => {
    setState(() => {
      return {
        ...getState(),
        ...state,
      };
    });
  },
});

export default function createNewStore<S>(
  state: S,
  options?: {
    name: string;
    devTools?: boolean;
    persist?:
      | boolean
      | {
          name: string;
          version: number;
          migrate?: (persistedState: any, version: number) => S;
          partialize?: (state: StoreState<S>) => Partial<StoreState<S>>;
        };
  }
) {
  const store: Store<S> = (setState: Setter<S>, getState: Getter<S>) => ({
    ...state,
    ...getActions(setState, getState, state),
  });

  let input = store as any;

  if (options) {
    if (options.persist) {
      const persistOptions: any = {
        name: "",
        version: 1,
      };
      if (typeof options.persist == "boolean") {
        persistOptions.name = options.name;
      } else {
        persistOptions.name = options.persist.name;
        persistOptions.version = options.persist.version;
        if (options.persist.migrate) {
          persistOptions.migrate = options.persist.migrate;
        }
        if (options.persist.partialize) {
          persistOptions.partialize = options.persist.partialize;
        }
      }
      input = persist(input, persistOptions);
    }

    if (options.devTools) {
      input = devtools(input, {
        name: options.name,
      });
    }
  }

  return create<StoreState<S>>()(input);
}