# PureScript Object Code Optimizer - Floated Thunks (JS) (Experimental)

**Status:** Alpha; largely vibe-coded. This is a quick-and-dirty experiment. It would be better implemented inside the PureScript compiler itself.

This tool rewrites the generated JavaScript from the **PureScript** compiler, specifically intended for the `index.js` modules. It lifts (hoists) certain expressions into cached thunks and then **forces** evaluation at the original site of the expression. It is **not** intended for use with foreign JS files.

It guards against unintended side effects by leaving zero-argument (nullary) function execution unoptimized.

> **Inspiration:** *Inspired the Haskell GHC optimization to [float let-bindings](https://downloads.haskell.org/ghc/9.12.2/docs/users_guide/using-optimisation.html). Because PureScript is strictly evaluated additional logic is required.


---

## What the script does

- Wraps selected expressions in **lazy, self-replacing thunks** so the underlying computation is done **once**, then reused.
- Floats/hoists those thunks to the outermost scope in which all bindings referenced are still available.
- Substitutes calls to those thunks back at the original locations, aiming to **preserve call semantics** of the original code (with the caveat that the wrapped computation executes a single time due to caching).
- The primary motivation is **computation-heavy code in partially applied contexts** (a common pattern in compiled PureScript), where repeated evaluation can be wasteful.

---

## What it does **not** guarantee

- **Performance:** It may be **faster or slower** depending on code shape, runtime, and bundler. It **will** make files **larger**.
- **Optimization:** It is **not optimized**. The helper/thunk code is **duplicated** in every file, and the transform itself hasn’t been tuned.
- **Robustness:** It’s alpha quality.

---

## Scope & Supported Inputs

- **Designed for:** PureScript compiler output files named `index.js`.
- **Not for:** Foreign JS modules (FFI files), hand-written JS, or arbitrary ESM/CJS files.

---

## Usage

Run it over your build output directory. E.g. on macOS:

```sh
find <build_dir> -name 'index.js' -exec ./inplace.js {} \;
```

## Contributions, etc.
Feedback, bug reports, and ideas are always welcome. Pull requests are encouraged.
For code submissions (features and bug fixes), please include the pre- and post-optimized JavaScript output in the test\_data directory.
