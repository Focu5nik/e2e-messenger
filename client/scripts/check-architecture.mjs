import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { checkBoundaries, sourceRoot } from '../packages/client-core/scripts/check-boundaries.mjs'

export const webRoot = fileURLToPath(new URL('../web/src/', import.meta.url))
const packageName = '@secure-messenger/client-core'

function inside(root, file) {
  const path = relative(root, file).replaceAll('\\', '/')
  return path !== '..' && !path.startsWith('../') && !path.includes(':')
}

function readSources(root, sources) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = resolve(root, entry.name)
    if (entry.isDirectory()) readSources(file, sources)
    else if (/\.tsx?$/.test(file)) sources.set(file, readFileSync(file, 'utf8'))
  }
}

// Includes type-only imports and re-exports, so a type cycle cannot hide a
// dependency that would become a runtime cycle after a later edit.
export function checkClientImports(sources) {
  const errors = []
  const graph = new Map()
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX }
  const host = { ...ts.sys, fileExists: (file) => sources.has(resolve(file)) || ts.sys.fileExists(file) }
  for (const [file, text] of sources) {
    const edges = []
    graph.set(file, edges)
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    function visit(node) {
      let specifier
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0]
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const name = specifier.text
        const resolved = name === packageName
          ? resolve(sourceRoot, 'index.ts')
          : ts.resolveModuleName(name, file, options, host).resolvedModule?.resolvedFileName
        const target = resolved && resolve(resolved)
        if (inside(webRoot, file)) {
          if (name.startsWith(`${packageName}/`) || (target && inside(sourceRoot, target) && name !== packageName)) {
            errors.push(`${file}: Import core through ${packageName}, not "${name}".`)
          }
          if (ts.isExportDeclaration(node) && (name === packageName || (target && inside(sourceRoot, target)))) {
            errors.push(`${file}: Compatibility re-exports of core are not allowed.`)
          }
          if ((inside(resolve(webRoot, 'features'), file) || inside(resolve(webRoot, 'app'), file)) &&
              target && inside(resolve(webRoot, 'shared/api'), target)) {
            errors.push(`${file}: UI must use store bindings instead of API adapters.`)
          }
        }
        if (target && sources.has(target)) edges.push(target)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  const visited = new Set()
  const active = new Set()
  function visit(file, path) {
    if (active.has(file)) {
      errors.push(`Circular dependency: ${[...path.slice(path.indexOf(file)), file].map((item) => relative(sourceRoot, item)).join(' -> ')}`)
      return
    }
    if (visited.has(file)) return
    visited.add(file)
    active.add(file)
    for (const target of graph.get(file) ?? []) visit(target, [...path, file])
    active.delete(file)
  }
  for (const file of graph.keys()) visit(file, [])
  return errors
}

export function checkArchitecture() {
  const sources = new Map()
  readSources(sourceRoot, sources)
  readSources(webRoot, sources)
  return [...checkBoundaries(), ...checkClientImports(sources)]
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkArchitecture()
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('Client architecture check passed: public core imports, one-way dependencies, no cycles.')
  }
}
