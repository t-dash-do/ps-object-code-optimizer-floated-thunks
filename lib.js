// babel-plugin-floated-binding.js
// Floats let bindings to the OUTERMOST valid scope in curried functions,
// wraps them in a lazy self-replacing thunk, and forces at the original site.
// Hoists ALL pure expressions except nullary (zero-argument) calls which may have side effects.

module.exports = function floatedBindingPlugin({ types: t }) {
  // Track nodes we generated so we don't reprocess them
  const GENERATED = new WeakSet();
  // Track reserved names per scope to avoid collisions across passes
  const RESERVED_NAMES = new WeakMap();

  function getReserved(scope) {
    let set = RESERVED_NAMES.get(scope);
    if (!set) {
      set = new Set(Object.keys(scope.bindings || {}));
      RESERVED_NAMES.set(scope, set);
    }
    return set;
  }

  function getProgram(path) {
    return path.findParent((p) => p.isProgram());
  }

  function getHelperName(pathOrProgram) {
    // IMPORTANT: call isProgram(), don't just read the property (which is a function).
    const progPath =
      pathOrProgram && typeof pathOrProgram.isProgram === "function" && pathOrProgram.isProgram()
        ? pathOrProgram
        : getProgram(pathOrProgram);
    return progPath.getData("fbHelperName") || "floatedBinding";
  }

  function getHelperId(path) {
    return t.identifier(getHelperName(path));
  }

  // ---------- utils ----------
  const isNullaryCall = (n) => t.isCallExpression(n) && n.arguments.length === 0;

  function exprContainsNullaryCall(n) {
    let bad = false;
    (function walk(x) {
      if (!x || bad) return;
      if (isNullaryCall(x)) {
        bad = true;
        return;
      }
      for (const k in x) {
        const v = x[k];
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v.type === "string") walk(v);
      }
    })(n);
    return bad;
  }

  function isPureEnoughInit(node) {
    if (!node) return false;
    // PureScript output is pure; avoid pulling *nullary* calls earlier.
    if (exprContainsNullaryCall(node)) return false;
    return true;
  }

  function containsFrameSensitiveThings(anyPath) {
    // Blocks hoisting when `this`, `arguments`, `super`, or `new.target` are used.
    // Pass a NodePath (not a bare node) so we can traverse with correct scoping.
    let bad = false;
    anyPath.traverse({
      ThisExpression(p) {
        bad = true;
        p.stop();
      },
      Identifier(p) {
        if (p.node.name === "arguments" && p.isReferencedIdentifier()) {
          bad = true;
          p.stop();
        }
      },
      Super(p) {
        bad = true;
        p.stop();
      },
      MetaProperty(p) {
        // Matches new.target
        if (
          t.isIdentifier(p.node.meta, { name: "new" }) &&
          t.isIdentifier(p.node.property, { name: "target" })
        ) {
          bad = true;
          p.stop();
        }
      },
    });
    return bad;
  }

  function isPureEnoughDecl(declPath) {
    const initPath = declPath.get("init");
    const init = initPath.node;
    if (!isPureEnoughInit(init)) return false;
    if (containsFrameSensitiveThings(initPath)) return false;
    return true;
  }

  function freeVarsOfNode(nodePath /* NodePath */) {
    const names = new Set();
    nodePath.traverse({
      Identifier(p) {
        if (!p.isReferencedIdentifier()) return;
        names.add(p.node.name);
      },
    });
    return Array.from(names);
  }

  function freeVarsOfDecl(declPath) {
    // DO NOT exclude the declared name; self-deps must be seen (e.g. var x = x || y)
    return freeVarsOfNode(declPath.get("init"));
  }

  function outermostScopeWith(allNames, startPath) {
    if (allNames.length === 0) {
      // No dependencies - can potentially hoist to program level
      return startPath.scope.getProgramParent();
    }

    // Start at the current function scope (or program)
    let currentScope = startPath.scope.getFunctionParent() || startPath.scope.getProgramParent();
    if (!currentScope) return null;

    // First, verify ALL dependencies can be found along the current lexical chain
    for (const name of allNames) {
      let found = false;
      let scope = startPath.scope; // search from the actual use-site
      while (scope) {
        if (scope.hasOwnBinding(name) || scope.hasGlobal(name)) {
          found = true;
          break;
        }
        scope = scope.parent;
      }
      if (!found) {
        // Unknown identifier at transform time -> be conservative: don't hoist
        return currentScope;
      }
    }

    // Now walk outward across *function* boundaries while all deps remain available
    let targetScope = currentScope;

    while (targetScope.parent) {
      // Find the next enclosing function or program
      let parentFunc = null;
      let searchScope = targetScope.parent;
      while (searchScope) {
        if (searchScope.path.isFunction() || searchScope.path.isProgram()) {
          parentFunc = searchScope;
          break;
        }
        searchScope = searchScope.parent;
      }
      if (!parentFunc) break;

      let canHoistToParent = true;

      for (const name of allNames) {
        // Resolve binding *from the use-site* to know which binding we actually refer to.
        const binding = startPath.scope.getBinding(name);

        if (!binding) {
          // Probably a global; if parent can also see it as global, fine.
          if (parentFunc.hasGlobal(name)) continue;
          canHoistToParent = false;
          break;
        }

        // The identifier is bound in binding.scope.
        // We can hoist into `parentFunc` only if `binding.scope` is the same as
        // or an ancestor of `parentFunc` (i.e., visible from parent).
        // If the binding lives inside the current function (params/locals),
        // then hoisting *above* that function would lose access.
        let s = parentFunc;
        let visible = false;
        while (s) {
          if (s === binding.scope) {
            visible = true;
            break;
          }
          s = s.parent;
        }
        // If not visible via ancestry, also allow when the name is a parameter of parentFunc itself.
        if (!visible && parentFunc.path.isFunction()) {
          const isParam = parentFunc.path.node.params.some(
            (p) => t.isIdentifier(p) && p.name === name
          );
          if (isParam) visible = true;
        }
        // Or if it is a global known to parent
        if (!visible && parentFunc.hasGlobal(name)) visible = true;

        if (!visible) {
          canHoistToParent = false;
          break;
        }
      }

      if (!canHoistToParent) break;
      targetScope = parentFunc;
    }

    return targetScope;
  }

  function sanitizeBase(base) {
    // Best-effort: keep identifier-safe chars only
    const cleaned = base.replace(/[^A-Za-z0-9_$]/g, "_");
    return cleaned || "fb";
  }

  // Ensure uniqueness against:
  //  - target scope and its ancestors (existing logic), AND
  //  - **every** scope from the use-site up to (but not past) the target scope
  //    to avoid being shadowed by any intermediate child scope.
  function makeUniqueFbName(base, targetScope, useSitePath) {
    base = sanitizeBase(base);
    const reserved = getReserved(targetScope);

    const taken = (n) => {
      // (a) anything reserved/declared/globally present in targetScope -> ancestors
      let s = targetScope;
      while (s) {
        const set = RESERVED_NAMES.get(s);
        if (set && set.has(n)) return true;
        if (s.hasBinding(n) || s.hasGlobal(n)) return true;
        s = s.parent;
      }
      // (b) any own-binding in scopes along the chain from use-site upward *until* targetScope
      let u = useSitePath.scope;
      while (u && u !== targetScope) {
        const setU = RESERVED_NAMES.get(u);
        if ((setU && setU.has(n)) || u.hasOwnBinding(n)) return true;
        u = u.parent;
      }
      return false;
    };

    // Start with base__fb
    let name = `${base}__fb`;
    if (!taken(name)) {
      reserved.add(name);
      return name;
    }
    // Then base__fb_<n>
    let i = 1;
    while (taken(`${base}__fb_${i}`)) i++;
    name = `${base}__fb_${i}`;
    reserved.add(name);
    return name;
  }

  function deriveBaseFromCall(path) {
    // Best effort: callee + identifier args, else generic
    let base = "fb";
    const { node } = path;
    if (t.isIdentifier(node.callee)) base = node.callee.name;
    else if (t.isCallExpression(node.callee) && t.isIdentifier(node.callee.callee))
      base = node.callee.callee.name;
    const argNames = node.arguments
      .map((a) => (t.isIdentifier(a) ? a.name : null))
      .filter(Boolean)
      .join("_");
    if (argNames) base = `${base}_${argNames}`;
    return sanitizeBase(base);
  }

  function ensureArrowBlock(funcPath) {
    if (funcPath.isArrowFunctionExpression() && !t.isBlockStatement(funcPath.node.body)) {
      const expr = funcPath.node.body;
      funcPath.get("body").replaceWith(t.blockStatement([t.returnStatement(expr)]));
    }
  }

  function getHoistInsertionPath(scope) {
    const p = scope.path;
    if (p.isProgram()) return p; // Program.body (array)
    if (p.isFunction()) {
      const body = p.get("body"); // BlockStatement
      if (!body.isBlockStatement()) {
        ensureArrowBlock(p);
        return p.get("body");
      }
      return body;
    }
    // Fallback: nearest block
    const block = p.findParent((q) => q.isBlockStatement());
    return block || p.getProgramParent().path;
  }

  function insertAfterPrologueAndImports(containerPath, nodeToInsert) {
    // containerPath is Program or BlockStatement
    const isProgram = containerPath.isProgram();
    const bodyPaths = containerPath.get("body");
    let anchor = null;

    for (const p of bodyPaths) {
      if (isProgram && p.isImportDeclaration()) {
        anchor = p;
        continue;
      }
      if (p.isExpressionStatement() && t.isStringLiteral(p.node.expression)) {
        // directive prologues (e.g. "use strict")
        anchor = p;
        continue;
      }
      // first non-import, non-directive statement
      break;
    }

    if (anchor) {
      anchor.insertAfter(nodeToInsert);
    } else {
      containerPath.unshiftContainer("body", nodeToInsert);
    }
  }

  function isInFloatedBinding(path) {
    const helperName = getHelperName(path);
    return !!path.findParent(
      (p) => p.isCallExpression() && t.isIdentifier(p.node.callee, { name: helperName })
    );
  }

  // ---------- inject helper once ----------
  function ensureHelper(programPath) {
    const key = "_floated_binding_helper_injected";
    if (programPath.getData(key)) return;
    programPath.setData(key, true);

    // Choose a collision-safe helper name
    const programScope = programPath.scope;
    const reserved = getReserved(programScope);
    const helperBase = "floatedBinding";
    let helperName = helperBase;

    const taken = (n) => {
      let s = programScope;
      while (s) {
        const set = RESERVED_NAMES.get(s);
        if (set && set.has(n)) return true;
        if (s.hasBinding(n) || s.hasGlobal(n)) return true;
        s = s.parent;
      }
      return false;
    };

    if (taken(helperName)) {
      let i = 1;
      while (taken(`${helperBase}_${i}`)) i++;
      helperName = `${helperBase}_${i}`;
    }
    reserved.add(helperName);
    programPath.setData("fbHelperName", helperName);

    const helper = t.functionDeclaration(
      t.identifier(helperName),
      [t.identifier("init")],
      t.blockStatement([
        t.variableDeclaration("let", [
          t.variableDeclarator(
            t.identifier("get"),
            t.arrowFunctionExpression(
              [],
              t.blockStatement([
                t.variableDeclaration("const", [
                  t.variableDeclarator(
                    t.identifier("v"),
                    t.callExpression(t.identifier("init"), [])
                  ),
                ]),
                // self-replacing function
                t.expressionStatement(
                  t.assignmentExpression(
                    "=",
                    t.identifier("get"),
                    t.arrowFunctionExpression([], t.identifier("v"))
                  )
                ),
                t.returnStatement(t.identifier("v")),
              ])
            )
          ),
        ]),
        t.returnStatement(
          t.arrowFunctionExpression([], t.callExpression(t.identifier("get"), []))
        ),
      ])
    );

    // Insert after imports and directives
    insertAfterPrologueAndImports(programPath, helper);
  }

  // ---------- analysis helpers kept (returned-cone utilities retained for compatibility) ----------
  function sameFunc(a, b) {
    return !!a && !!b && a.node && b.node && a.node === b.node;
  }

  function isInReturnExprOf(path, funcPath) {
    let p = path;
    while (p && !p.isProgram()) {
      if (p.isFunction() && !sameFunc(p, funcPath)) return false; // crossed into other function
      if (p.isReturnStatement()) {
        const owner = p.getFunctionParent();
        return sameFunc(owner, funcPath);
      }
      p = p.parentPath;
    }
    return false;
  }

  function refInReturnedCone(refPath, declFuncPath) {
    if (isInReturnExprOf(refPath, declFuncPath)) return true;

    const innerFunc = refPath.getFunctionParent();
    if (innerFunc && !sameFunc(innerFunc, declFuncPath)) {
      let funcPath = innerFunc.path;
      while (funcPath && !sameFunc(funcPath.getFunctionParent(), declFuncPath)) {
        funcPath = funcPath.parentPath;
      }
      if (funcPath && funcPath.isReturnStatement()) return true;

      const retAncestor = innerFunc.findParent((p) => p.isReturnStatement());
      if (retAncestor) {
        const owner = retAncestor.getFunctionParent();
        if (sameFunc(owner, declFuncPath)) return true;
      }
    }

    let parent = refPath.parentPath;
    if (parent && parent.isCallExpression() && parent.node.arguments.includes(refPath.node)) {
      return isInReturnExprOf(parent, declFuncPath);
    }

    return false;
  }

  // ---------- main ----------
  return {
    name: "floated-binding-let-floating",
    visitor: {
      Program(programPath) {
        ensureHelper(programPath);
      },

      // Feature: lift eligible call expressions used anywhere (except nullary calls)
      CallExpression(path) {
        // Skip generated or protected nodes to avoid infinite loops
        if (GENERATED.has(path.node)) return;

        const callee = path.node.callee;
        if (t.isIdentifier(callee) && /__fb(_\d+)?$/.test(callee.name)) return; // calls to fb thunks
        if (t.isIdentifier(callee) && callee.name === getHelperName(path)) return; // helper itself
        if (isInFloatedBinding(path)) return; // inside the helper's arrow body

        // Not inside a function? skip (avoid class fields / top-level)
        const funcParent = path.getFunctionParent();
        if (!funcParent) return;

        // For call expressions that are part of variable declarations,
        // let the VariableDeclarator visitor handle them
        if (path.parent && t.isVariableDeclarator(path.parent) && path.parent.init === path.node) {
          return; // Will be handled by VariableDeclarator visitor
        }

        // Purity/eligibility
        if (!isPureEnoughInit(path.node)) return;
        if (containsFrameSensitiveThings(path)) return;

        // Free vars of this expression
        const fvs = freeVarsOfNode(path);
        const targetScope = outermostScopeWith(fvs, path);
        if (!targetScope) return;

        // Don't hoist if the target scope is the same as the current scope
        const currentScope = path.scope.getFunctionParent() || path.scope.getProgramParent();
        if (targetScope === currentScope) return;

        // Skip expression lifting if it depends on any local (non-param) binding
        const dependsOnLocalVar = fvs.some((n) => {
          const b = path.scope.getBinding(n);
          if (!b) return false;
          if (b.kind === "param") return false; // parameters are OK in current function
          if (b.kind === "var" || b.kind === "let" || b.kind === "const") return true;
          return false;
        });
        if (dependsOnLocalVar) return;

        // Build unique name like add_y__fb where possible; ensure uniqueness along the path
        const base = deriveBaseFromCall(path);
        const fbName = makeUniqueFbName(base, targetScope, path);
        const fbId = t.identifier(fbName);

        // Hoisted decl: const <name>__fb = floatedBinding(() => <expr>);
        const cloned = t.cloneNode(path.node, /*deep*/ true);
        GENERATED.add(cloned);
        const fbDecl = t.variableDeclaration("const", [
          t.variableDeclarator(
            fbId,
            t.callExpression(getHelperId(path), [t.arrowFunctionExpression([], cloned)])
          ),
        ]);
        GENERATED.add(fbDecl);

        // Insert hoisted declaration after prologue/imports
        const insertionPath = getHoistInsertionPath(targetScope);
        if (insertionPath.isProgram() || insertionPath.isBlockStatement()) {
          insertAfterPrologueAndImports(insertionPath, fbDecl);
        } else {
          const sp = insertionPath.getStatementParent();
          if (sp) sp.insertBefore(fbDecl);
        }

        // Replace original expression with call to the thunk (in place)
        const fbCall = t.callExpression(fbId, []);
        GENERATED.add(fbCall);
        path.replaceWith(fbCall);
        path.skip();
      },

      VariableDeclarator(path) {
        // Only simple `var/let/const x = <expr>` inside a function (NOT top-level)
        const vd = path.parentPath.node;
        if (!t.isIdentifier(path.node.id)) return;
        if (!t.isVariableDeclaration(vd)) return;
        if (!(vd.kind === "const" || vd.kind === "let" || vd.kind === "var")) return;
        if (GENERATED.has(path.node) || GENERATED.has(path.parentPath.node)) return;

        const funcParent = path.getFunctionParent();
        if (!funcParent) return; // true top-level → skip

        if (!path.node.init) return;
        if (!isPureEnoughDecl(path)) return;

        // Check if this variable is used at all
        const binding = path.scope.getBinding(path.node.id.name);
        if (!binding || binding.referencePaths.length < 1) return;

        // Remove the return cone restriction - we want to hoist ALL pure expressions
        // The only restriction is nullary calls and frame-sensitive things (handled above)

        // Free variables (DO NOT exclude the declared id)
        const fvs = freeVarsOfDecl(path);

        // If we have no info about dependencies, don't hoist
        if (fvs.length === 0 && path.node.init && !t.isLiteral(path.node.init)) {
          return;
        }

        const targetScope = outermostScopeWith(fvs, path);
        if (!targetScope) return;

        // Don't hoist if the target scope is the same as the current scope
        const currentScope = path.scope.getFunctionParent() || path.scope.getProgramParent();
        if (targetScope === currentScope) return;

        const fbName = makeUniqueFbName(path.node.id.name, targetScope, path);
        const fbId = t.identifier(fbName);

        // 1) Hoist caching thunk at the outermost valid scope
        const initClone = t.cloneNode(path.node.init, /*deep*/ true);
        GENERATED.add(initClone);
        const fbDecl = t.variableDeclaration("const", [
          t.variableDeclarator(
            fbId,
            t.callExpression(getHelperId(path), [t.arrowFunctionExpression([], initClone)])
          ),
        ]);
        GENERATED.add(fbDecl);

        const insertionPath = getHoistInsertionPath(targetScope);
        if (insertionPath.isProgram() || insertionPath.isBlockStatement()) {
          insertAfterPrologueAndImports(insertionPath, fbDecl);
        } else {
          const sp = insertionPath.getStatementParent();
          if (sp) sp.insertBefore(fbDecl);
        }

        // 2) Force at original binding site: swap RHS to `<id>__fb()` (1:1 replacement)
        const initPath = path.get("init");
        if (initPath && initPath.node) {
          const fbCall = t.callExpression(fbId, []);
          GENERATED.add(fbCall);
          initPath.replaceWith(fbCall);
        }
      },
    },
  };
};
