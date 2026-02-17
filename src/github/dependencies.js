/**
 * Build a dependency graph from a list of issues and return topologically sorted order.
 *
 * @param {Array<{ id: string, dependsOn?: string[] }>} issues
 * @returns {{ sorted: string[], cycles: string[][] }}
 */
export function buildDependencyGraph(issues) {
  /** @type {Map<string, Set<string>>} node -> set of nodes it depends on */
  const deps = new Map();
  /** @type {Map<string, Set<string>>} node -> set of nodes that depend on it */
  const dependents = new Map();
  const ids = new Set(issues.map((i) => i.id));

  for (const issue of issues) {
    if (!deps.has(issue.id)) deps.set(issue.id, new Set());
    if (!dependents.has(issue.id)) dependents.set(issue.id, new Set());

    for (const dep of issue.dependsOn || []) {
      if (!ids.has(dep)) continue; // skip external deps
      deps.get(issue.id).add(dep);
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep).add(issue.id);
    }
  }

  return topologicalSort(ids, deps, dependents);
}

/**
 * Kahn's algorithm for topological sort with cycle detection.
 *
 * @param {Set<string>} ids
 * @param {Map<string, Set<string>>} deps - node -> its dependencies
 * @param {Map<string, Set<string>>} dependents - node -> nodes depending on it
 * @returns {{ sorted: string[], cycles: string[][] }}
 */
function topologicalSort(ids, deps, dependents) {
  const inDegree = new Map();
  for (const id of ids) {
    inDegree.set(id, deps.get(id)?.size || 0);
  }

  const queue = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted = [];
  while (queue.length > 0) {
    const node = queue.shift();
    sorted.push(node);

    for (const dependent of dependents.get(node) || []) {
      const newDegree = inDegree.get(dependent) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  // Detect cycles: any node not in sorted still has unresolved deps
  const cycles = [];
  if (sorted.length < ids.size) {
    const remaining = new Set([...ids].filter((id) => !sorted.includes(id)));
    // Simple cycle detection: walk from each remaining node
    const visited = new Set();
    for (const start of remaining) {
      if (visited.has(start)) continue;
      const cycle = [];
      let current = start;
      const path = new Set();
      while (current && !path.has(current)) {
        path.add(current);
        visited.add(current);
        cycle.push(current);
        // Follow first unresolved dependency
        const nodeDeps = deps.get(current);
        current = nodeDeps
          ? [...nodeDeps].find((d) => remaining.has(d) && !path.has(d))
          : undefined;
      }
      if (cycle.length > 1) cycles.push(cycle);
    }

    // Append remaining nodes after sorted (breaking cycles)
    for (const id of remaining) {
      sorted.push(id);
    }
  }

  return { sorted, cycles };
}

/**
 * Get the issues in execution order, respecting dependencies.
 *
 * @param {Array<{ id: string, title: string, dependsOn?: string[] }>} issues
 * @returns {Array<{ id: string, title: string, dependsOn?: string[] }>}
 */
export function orderByDependencies(issues) {
  const { sorted } = buildDependencyGraph(issues);
  const byId = new Map(issues.map((i) => [i.id, i]));
  return sorted.map((id) => byId.get(id)).filter(Boolean);
}
