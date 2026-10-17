'use strict';

function orderMigrations(files, document = { schemaVersion: 1, dependencies: {} }) {
  if (document.schemaVersion !== 1 || !document.dependencies || typeof document.dependencies !== 'object' || Array.isArray(document.dependencies)) {
    throw new Error('Invalid migration dependency manifest');
  }
  const byVersion = new Map(files.map(file => [file.version, file]));
  for (const [version, dependencies] of Object.entries(document.dependencies)) {
    if (!byVersion.has(version)) throw new Error(`Dependency manifest references missing migration ${version}`);
    if (!Array.isArray(dependencies) || dependencies.some(dependency => typeof dependency !== 'string') || new Set(dependencies).size !== dependencies.length) {
      throw new Error(`Invalid dependencies for migration ${version}`);
    }
    for (const dependency of dependencies) if (!byVersion.has(dependency)) throw new Error(`Missing prerequisite ${dependency} for migration ${version}`);
  }
  const result = [], visiting = new Set(), visited = new Set();
  function visit(version) {
    if (visiting.has(version)) throw new Error(`Migration dependency cycle at ${version}`);
    if (visited.has(version)) return;
    visiting.add(version);
    const dependencies = [...(document.dependencies[version] || [])].sort();
    for (const dependency of dependencies) visit(dependency);
    visiting.delete(version); visited.add(version);
    result.push({ ...byVersion.get(version), dependencies });
  }
  for (const file of [...files].sort((a, b) => a.version.localeCompare(b.version))) visit(file.version);
  return result;
}

module.exports = { orderMigrations };
